import { spawn, execFileSync, execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import express from 'express';
import { loadConfig } from './config.js';
import { ProcessManager } from './core/process-manager.js';
import { createHttpAdapter } from './adapters/http.js';
import { createTelegramAdapter } from './adapters/telegram.js';
import { PushRegistry } from './core/push-registry.js';

const config = loadConfig();
const processManager = new ProcessManager(config);

// Ensure heartbeat scheduled job is installed (launchd on macOS, systemd on Linux)
function ensureHeartbeat(): void {
  const installScript = resolve(import.meta.dirname, '..', 'heartbeat', 'install.sh');
  if (!existsSync(installScript)) return;

  try {
    execFileSync('bash', [installScript], { stdio: 'pipe' });
    console.log('[bareclaw] heartbeat scheduled job installed');
  } catch (err) {
    console.error(`[bareclaw] heartbeat install failed: ${err instanceof Error ? err.message : err}`);
  }
}
ensureHeartbeat();

// Ensure WhatsApp daemon is running (Baileys WebSocket bridge)
function ensureWhatsAppDaemon(): void {
  const daemonDir = resolve(homedir(), '.claude', 'skills', 'whatsapp', 'scripts', 'daemon');
  if (!existsSync(resolve(daemonDir, 'index.ts'))) return;

  // Read port from config.env if available
  let port = '3001';
  const configPath = resolve(homedir(), '.claude', 'skills', 'whatsapp', 'scripts', 'config.env');
  if (existsSync(configPath)) {
    try {
      const configContent = execSync(`grep WHATSAPP_DAEMON_PORT ${configPath} 2>/dev/null || true`, { encoding: 'utf8' });
      const match = configContent.match(/WHATSAPP_DAEMON_PORT=(\d+)/);
      if (match) port = match[1]!;
    } catch { /* use default */ }
  }

  // Check if already running
  try {
    execSync(`curl -sf --max-time 2 http://localhost:${port}/health`, { stdio: 'pipe' });
    console.log(`[bareclaw] WhatsApp daemon already running on :${port}`);
    return;
  } catch { /* not running, start it */ }

  // Check if npm install has been run
  if (!existsSync(resolve(daemonDir, 'node_modules'))) {
    console.log('[bareclaw] WhatsApp daemon: running npm install...');
    try {
      execSync('npm install', { cwd: daemonDir, stdio: 'pipe' });
    } catch (err) {
      console.error(`[bareclaw] WhatsApp daemon npm install failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  try {
    const child = spawn('npx', ['tsx', 'index.ts'], {
      cwd: daemonDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WHATSAPP_DAEMON_PORT: port },
    });

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[whatsapp] ${line}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[whatsapp] ${line}`);
    });

    child.unref();
    console.log(`[bareclaw] WhatsApp daemon starting on :${port} (pid ${child.pid})`);
  } catch (err) {
    console.error(`[bareclaw] WhatsApp daemon start failed: ${err instanceof Error ? err.message : err}`);
  }
}
ensureWhatsAppDaemon();

// Self-restart: shut down everything, re-exec the same process
function restart() {
  console.log('[bareclaw] restarting...');
  processManager.shutdown();
  server.close(() => {
    const child = spawn(process.argv[0]!, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.unref();
    process.exit(0);
  });
  // If server.close hangs, force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

// Push registry — adapters register handlers for outbound messages via POST /send
const pushRegistry = new PushRegistry();

// Telegram (optional) — register push handler before HTTP so /send is ready at startup
if (config.telegramToken) {
  const { bot, pushHandler } = createTelegramAdapter(config, processManager);
  pushRegistry.register('tg-', pushHandler);
  bot.launch();
  console.log(`[bareclaw] Telegram bot started (${config.allowedUsers.length} allowed user(s))`);
} else {
  console.log(`[bareclaw] Telegram disabled (no BARECLAW_TELEGRAM_TOKEN)`);
}

// HTTP
const app = express();
app.use(express.json());
app.use(createHttpAdapter(config, processManager, restart, pushRegistry));

const server = app.listen(config.port, () => {
  console.log(`[bareclaw] HTTP listening on :${config.port}`);
  if (config.httpToken) {
    console.log(`[bareclaw] HTTP auth enabled (Bearer token)`);
  } else {
    console.log(`[bareclaw] HTTP auth disabled (no BARECLAW_HTTP_TOKEN)`);
  }
});

// SIGTERM (tsx watch sends this on hot reload) — disconnect, keep session hosts alive
process.on('SIGTERM', () => {
  console.log('\n[bareclaw] hot reload — disconnecting from session hosts...');
  processManager.shutdown();
  process.exit(0);
});

// SIGINT (Ctrl+C) — full shutdown, kill session hosts
process.on('SIGINT', () => {
  console.log('\n[bareclaw] full shutdown — killing session hosts...');
  processManager.shutdownHosts();
  process.exit(0);
});

process.on('SIGHUP', restart);

// Prevent crashes from unhandled errors
process.on('unhandledRejection', (err) => {
  console.error(`[bareclaw] unhandled rejection: ${err instanceof Error ? err.message : err}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[bareclaw] uncaught exception: ${err.message}`);
});
