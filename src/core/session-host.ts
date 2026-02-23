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
  channelContext?: { channel: string; adapter: string };
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
 * Messages are written directly to Claude's stdin pipe. The OS pipe
 * handles buffering if Claude isn't ready to read yet — no application-
 * level gating needed.
 *
 * When Claude is dead (exited/crashed), we buffer messages until the next
 * spawnClaude() call flushes them into the new process's stdin.
 */
let pendingMessages: string[] = [];

function flushPending() {
  if (pendingMessages.length === 0) return;
  log(`flushing ${pendingMessages.length} buffered message(s)`);
  for (const msg of pendingMessages) {
    if (claude.stdin && !claude.stdin.destroyed) {
      claude.stdin.write(msg + '\n');
    }
  }
  pendingMessages = [];
}

function spawnClaude() {

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
  if (config.channelContext) {
    args.push('--append-system-prompt',
      `You are operating on BAREclaw channel "${config.channelContext.channel}" (adapter: ${config.channelContext.adapter}).`
    );
  }

  log(`spawning claude${lastSessionId ? ` (resuming ${lastSessionId.substring(0, 8)}...)` : ''}`);

  claude = spawn('claude', args, {
    env: baseEnv as NodeJS.ProcessEnv,
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  claudeRl = createInterface({ input: claude.stdout!, crlfDelay: Infinity });

  // Forward Claude stdout → socket client
  claudeRl.on('line', (line) => {
    try {
      const event = JSON.parse(line);

      // Capture session ID for future respawns
      if (event.type === 'result' && event.session_id) {
        lastSessionId = event.session_id;
        log(`captured session_id: ${lastSessionId!.substring(0, 8)}...`);
      }
    } catch {}

    // Forward to client
    if (client && !client.destroyed) {
      client.write(line + '\n');
    }
  });

  // Flush any messages that arrived while Claude was dead
  flushPending();

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
    // If Claude died, buffer the message and respawn
    if (claude.exitCode !== null || claude.killed) {
      pendingMessages.push(line);
      log('claude is dead, respawning before dispatch');
      spawnClaude();
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
