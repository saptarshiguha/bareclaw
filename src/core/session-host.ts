/**
 * Session host — a detached process that holds a Claude session.
 * Survives server hot reloads. Communicates via Unix domain socket.
 *
 * Spawned by ProcessManager, not imported directly.
 * Usage: tsx session-host.ts '<json-config>'
 */

import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Socket } from 'net';
import { createInterface, type Interface } from 'readline';
import { unlinkSync, writeFileSync, appendFileSync } from 'fs';

interface HostConfig {
  channel: string;
  socketPath: string;
  pidFile: string;
  cwd: string;
  maxTurns: number;
  allowedTools: string;
  resumeSessionId?: string;
}

const config: HostConfig = JSON.parse(process.argv[2]!);
const logFile = `/tmp/bareclaw-${config.channel}.log`;

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 19);
  appendFileSync(logFile, `[${ts}] ${msg}\n`);
}

// Clean stale socket
try { unlinkSync(config.socketPath); } catch {}

// Strip API keys from env
const { ANTHROPIC_API_KEY, CLAUDE_API_KEY, ...parentEnv } = process.env;
const baseEnv = {
  ...parentEnv,
  CLAUDECODE: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

let claude: ChildProcess;
let claudeRl: Interface;
let client: Socket | null = null;
let lastSessionId: string | undefined = config.resumeSessionId;

/**
 * When Claude resumes a session, it replays ALL historical events through
 * stdout before processing new input. We must suppress these replay events
 * and buffer any client messages until replay is done.
 *
 * For resumed sessions: wait for events to stop flowing (2s quiet gap).
 * For fresh sessions: ready immediately (no replay).
 */
let claudeReady = false;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMessages: string[] = [];
const REPLAY_QUIET_MS = 2000; // Time to wait after last replay event

function onClaudeReady() {
  claudeReady = true;
  log(`claude ready (replay done, ${pendingMessages.length} message(s) buffered)`);
  // Flush buffered messages
  for (const msg of pendingMessages) {
    if (claude.stdin && !claude.stdin.destroyed) {
      claude.stdin.write(msg + '\n');
    }
  }
  pendingMessages = [];
}

function spawnClaude() {
  claudeReady = false;
  pendingMessages = [];
  if (readyTimer) clearTimeout(readyTimer);

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(config.maxTurns),
    '--allowedTools', config.allowedTools,
  ];
  if (lastSessionId) {
    args.push('--resume', lastSessionId);
  }

  log(`spawning claude${lastSessionId ? ` (resuming ${lastSessionId.substring(0, 8)}...)` : ''}`);

  claude = spawn('claude', args, {
    env: baseEnv as NodeJS.ProcessEnv,
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  claudeRl = createInterface({ input: claude.stdout!, crlfDelay: Infinity });

  // Forward Claude stdout → socket client (suppressing replay events)
  claudeRl.on('line', (line) => {
    // Capture session ID regardless of replay state
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && event.session_id) {
        lastSessionId = event.session_id;
        log(`captured session_id: ${lastSessionId!.substring(0, 8)}...`);
      }
    } catch {}

    if (!claudeReady) {
      // Still replaying — reset the quiet timer on each event
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = setTimeout(onClaudeReady, REPLAY_QUIET_MS);
      return; // Don't forward replay events to client
    }

    // Forward live events to client
    if (client && !client.destroyed) {
      client.write(line + '\n');
    }
  });

  // Fresh sessions (no resume): ready immediately — no replay to wait for.
  // Resumed sessions: wait for event-based quiet detection.
  if (!lastSessionId) {
    claudeReady = true;
    log('fresh session — no replay to wait for');
  }

  // Forward Claude stderr → socket client as internal event
  claude.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      log(`stderr: ${text.substring(0, 200)}`);
      if (!text.includes('zoxide') && client && !client.destroyed) {
        try {
          client.write(JSON.stringify({ type: '_stderr', text: text.substring(0, 500) }) + '\n');
        } catch {}
      }
    }
  });

  claude.on('error', (err) => {
    log(`claude error: ${err.message}`);
  });

  // Auto-respawn when Claude exits (max turns, crash, etc.)
  claude.on('exit', (code) => {
    log(`claude exited (code ${code}) — will respawn on next message`);
    // If we were still replaying, mark as ready so buffered messages can trigger respawn
    if (!claudeReady) {
      if (readyTimer) clearTimeout(readyTimer);
      claudeReady = true;
    }
    // Notify client that the current dispatch should fail gracefully
    if (client && !client.destroyed) {
      try {
        client.write(JSON.stringify({
          type: 'result',
          result: `[Session ended (exit code ${code}). Next message will start a fresh session${lastSessionId ? ' with resume' : ''}.]\n`,
          is_error: true,
        }) + '\n');
      } catch {}
    }
  });
}

spawnClaude();

// Socket server — accepts one client at a time (the bareclaw server)
const server = createServer((socket) => {
  log('client connected');
  if (client && !client.destroyed) {
    client.destroy();
  }
  client = socket;

  const socketRl = createInterface({ input: socket, crlfDelay: Infinity });
  socketRl.on('line', (line) => {
    // Handle interrupt signal — SIGINT Claude to stop current turn
    // Ignore interrupts during replay — Claude isn't processing anything yet
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'interrupt') {
        if (!claudeReady) {
          log('interrupt ignored (still replaying)');
          return;
        }
        log('interrupt requested — sending SIGINT to claude');
        claude.kill('SIGINT');
        return;
      }
    } catch {}

    // If Claude died, respawn before sending the message
    if (claude.exitCode !== null || claude.killed) {
      log('claude is dead, respawning before dispatch');
      spawnClaude();
    }

    // Buffer message if Claude is still replaying history
    if (!claudeReady) {
      pendingMessages.push(line);
      return;
    }

    if (claude.stdin && !claude.stdin.destroyed) {
      claude.stdin.write(line + '\n');
    }
  });

  socket.on('close', () => {
    log('client disconnected');
    if (client === socket) client = null;
  });

  socket.on('error', (err) => {
    log(`socket error: ${err.message}`);
    if (client === socket) client = null;
  });
});

server.listen(config.socketPath, () => {
  writeFileSync(config.pidFile, String(process.pid));
  log(`listening on ${config.socketPath} (pid ${process.pid})`);
});

function cleanup() {
  try { unlinkSync(config.socketPath); } catch {}
  try { unlinkSync(config.pidFile); } catch {}
}

process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down');
  claude.kill();
  cleanup();
  server.close();
  process.exit(0);
});

// Ignore SIGINT — the parent server handles Ctrl+C
process.on('SIGINT', () => {});

process.on('uncaughtException', (err) => {
  log(`uncaught exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err instanceof Error ? err.message : err}`);
});
