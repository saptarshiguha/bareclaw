# BAREclaw

One daemon, many mouths, one brain. The bare minimum between you and your AI.

BAREclaw is a thin daemon that multiplexes input channels (HTTP, Telegram, SMS, etc.) into persistent Claude Code CLI processes. Every channel gets its own session with full context, tools, skills, MCP servers, and CLAUDE.md. Responses come back out the same way they came in.

The key design choice: BAREclaw shells out to `claude -p` rather than using the Agent SDK. CLI shelling goes through the Claude Max subscription (flat-rate unlimited). The SDK bills per API token. For a personal daemon, the marginal cost is $0.

The key design consequence: Claude running through BAREclaw has full tool access, including `Bash`, `Write`, and `Edit`. It can modify BAREclaw's own source code and trigger a restart to pick up the changes. BAREclaw is the simplest thing that could build itself.

## Quick start

```bash
cd ~/dev/tools/bareclaw
npm install
cp .env.example .env   # edit if needed — works with zero config for localhost
npm run dev             # runs via tsx with .env file watching
```

Send it a message:

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "hello"}'
```

First message per channel is slow (~15-30s, spawning claude). Subsequent messages reuse the warm process (3-5s).

## Architecture

```
[curl / Shortcut / Telegram / SMS / ...]
    → adapter (translates channel protocol → internal API)
        → ProcessManager.send(channel, content, context?)
            → session host (detached process per channel)
                → persistent claude process
        ← { text, duration_ms }
    ← response via same channel
```

```
src/
  index.ts                 # Entry point: Express server, Telegram bot, signals, self-restart
  config.ts                # Env var loading with defaults and type conversion
  core/
    types.ts               # Protocol types (ClaudeInput, ClaudeEvent, ChannelContext, etc.)
    session-host.ts        # Detached process holding a single Claude session, communicates via Unix socket
    process-manager.ts     # THE core — manages channels, spawns/connects session hosts, FIFO dispatch
    push-registry.ts       # Routes outbound push messages (POST /send) to the right adapter
  adapters/
    http.ts                # POST /message, POST /restart, optional Bearer auth
    telegram.ts            # Telegraf bot, long polling, required user allowlist
```

**ProcessManager** is the only file with real complexity. One persistent Claude process per channel, lazy-spawned, with strict FIFO queuing per channel and auto-reconnect to session hosts. It is deliberately adapter-agnostic — it accepts an opaque channel string and handles everything else.

**Session hosts** are detached processes that each hold a single Claude session. They communicate with ProcessManager via Unix domain sockets and survive server hot reloads — only a full shutdown (Ctrl+C / SIGINT) kills them.

**Adapters** are thin. Their only jobs are: (1) derive a channel key from the protocol's natural session boundary, (2) build a `ChannelContext` with adapter metadata, (3) call `processManager.send(channel, content, context)`, and (4) format the response for the client. Adapters must not implement their own queuing, session management, or concurrency control — ProcessManager owns all of that.

## Channels

A **channel** is the fundamental unit of session identity. Each unique channel string maps to exactly one persistent Claude process, one FIFO message queue, and one resumable session ID.

Channels are the **only abstraction ProcessManager knows about**. It has zero awareness of adapters, protocols, or where messages come from. This is a deliberate design constraint — it means every adapter gets the same queuing, dispatch, and session-persistence behavior for free, with no adapter-specific code paths inside the core.

### Channel properties

- **Adapter-agnostic.** The channel key is an opaque string. ProcessManager never parses, validates, or inspects it. Two adapters using the same channel key talk to the same Claude session — this is a feature, not a bug.
- **One queue per channel.** Each channel has its own independent FIFO queue. Messages sent to different channels are fully concurrent. Messages sent to the _same_ channel are serialized.
- **Persistent across restarts.** Session IDs are saved to `.bareclaw-sessions.json` keyed by channel. On reconnection, the session resumes automatically via `--resume`.

### Channel key conventions

Adapters derive channel keys from whatever their natural session boundary is. The key rules:

1. **Prefix with a short adapter identifier** (`http-`, `tg-`, `ws-`, etc.) to avoid collisions between adapters.
2. **One channel per independent conversation context.** A Telegram chat, a Discord thread, a WebSocket connection — each gets its own channel.
3. **Never hardcode a single channel for an entire adapter.** Every adapter must support multiple simultaneous channels.
4. **Keep keys short and filesystem-safe.** Channel keys end up in Unix socket paths (`/tmp/bareclaw-<channel>.sock`), so avoid special characters.

**Current adapters:**

| Adapter | Channel key | Derived from |
|---------|------------|--------------|
| HTTP | Caller-controlled via `channel` field. Defaults to `"http"`. | Request body |
| Telegram | `tg-<chatId>` | `ctx.chat.id` |

> **Pro tip:** Telegram supergroups with **Topics** enabled give you multiple independent Claude sessions in one group. Each topic is a separate conversation thread — create topics like "Code Review", "Research", "Ops" and each gets its own persistent session with isolated context. Currently all topics in a group share one channel (keyed by chat ID), but this is a natural extension point: key on `chatId-threadId` to get per-topic sessions.

## Concurrency model

BAREclaw handles multiple simultaneous messages correctly, whether they arrive on the same channel or different channels:

### Different channels → fully concurrent

Each channel has its own session host process, socket connection, and queue. Messages to `tg-123` and `tg-456` are dispatched in parallel with zero interaction. There is no global lock.

### Same channel → strict FIFO

Within a single channel, messages are processed **one at a time, in arrival order**. This is enforced by the `busy` flag and queue in ProcessManager:

1. First message arrives → channel is idle → dispatch immediately, set `busy = true`.
2. Second message arrives while first is processing → `busy` is true → push to queue, return a pending promise.
3. First message completes (`result` event) → set `busy = false` → `drainQueue()` shifts the next message and dispatches it.
4. Repeat until queue is empty.

This is not a limitation — it's a requirement. Claude's NDJSON stdio protocol is a single sequential stream. Sending a second message before the first completes would corrupt the stream and produce undefined behavior.

### Rapid-fire messages and coalescing

When a user sends multiple messages while a channel is busy, they queue up. Rather than processing each as a separate Claude turn, `drainQueue()` **coalesces** all waiting messages into a single turn — their text is joined with double newlines and dispatched as one message. This handles the common pattern of sending fragmented thoughts in quick succession.

How it works:

1. Messages arrive while channel is busy → queued normally.
2. Current turn finishes → `drainQueue()` takes **all** queued messages at once.
3. If multiple: combine text, resolve earlier callers' promises with `{ coalesced: true }`, dispatch combined text with the last caller's `onEvent` callback.
4. If only one: dispatch normally (no coalescing overhead).

Adapters check `response.coalesced` and skip sending a response for those messages — the combined message's handler takes care of it. Zero latency added to the happy path (idle channel → immediate dispatch).

## Writing a new adapter

Adapters are intentionally thin. Here's the contract:

1. **Derive a channel key** from the protocol's natural session boundary. Prefix it with an adapter identifier (e.g., `ws-`, `discord-`). See channel key conventions above.
2. **Build a `ChannelContext`** with channel, adapter name, and any available metadata (user name, chat title, topic). This is prepended to every message so Claude knows where it's coming from.
3. **Call `processManager.send(channel, content, context)`** and await the result. That's it for the core interaction — ProcessManager handles spawning, queuing, session persistence, and reconnection.
4. **Do not implement your own queuing or concurrency control.** ProcessManager owns all of that. If two messages arrive simultaneously for the same channel, both `send()` calls will resolve correctly in order.
5. **Handle your own output ordering** if the adapter streams intermediate events. The `onEvent` callback fires for every Claude event (assistant messages, tool use, etc.) before the final result. If your protocol delivers these to the user, chain the sends to preserve order (see the Telegram adapter's `sendChain` pattern).
6. **Handle errors from `send()`** — it can reject if the session host disconnects.
7. **Check `response.coalesced`** — if true, this message was folded into a subsequent turn. Skip sending a response.

See `src/adapters/telegram.ts` as the reference implementation and `src/adapters/http.ts` as the minimal case.

## Protocol

Messages in (NDJSON on stdin). When a `ChannelContext` is provided, ProcessManager prepends a metadata prefix to the content so Claude knows which channel, adapter, and user the message came from:
```json
{"type":"user","message":{"role":"user","content":"[channel: tg-123, adapter: telegram, user: Alice]\nhello"}}
```

Results out (NDJSON on stdout):
```json
{"type":"result","result":"Hello!","duration_ms":4200}
```

Process stays alive between messages. Session context preserved automatically.

## Configuration

All configuration is via environment variables. Everything has a sensible default — BAREclaw works with zero config for localhost use. See `.env.example` for the full list.

| Variable | Default | Description |
|---|---|---|
| `BARECLAW_PORT` | `3000` | HTTP server port |
| `BARECLAW_CWD` | `$HOME` | Working directory for `claude` processes. Determines which `CLAUDE.md` and project context Claude sees. |
| `BARECLAW_MAX_TURNS` | `25` | Max agentic turns per message. Prevents runaway tool loops. |
| `BARECLAW_ALLOWED_TOOLS` | `Read,Glob,Grep,Bash,Write,Edit,Skill,Task` | Tools auto-approved without interactive confirmation. Comma-separated. |
| `BARECLAW_TIMEOUT_MS` | `0` | Per-message timeout. **Must be `0` (no timeout).** Sessions are persistent and agentic — responses can take minutes. A non-zero value kills the socket mid-response and corrupts channel state. |
| `BARECLAW_HTTP_TOKEN` | *(none)* | Bearer token for HTTP auth. If unset, HTTP is unauthenticated. |
| `BARECLAW_TELEGRAM_TOKEN` | *(none)* | Telegram bot token from @BotFather. Omit to disable Telegram entirely. |
| `BARECLAW_ALLOWED_USERS` | *(none)* | Comma-separated Telegram user IDs. **Required** when Telegram is enabled. |

### Setting `BARECLAW_CWD`

This controls the project context for all `claude` processes:

- `~/dev/myproject` — Claude sees that project's `CLAUDE.md`, can read/edit its files, runs tools in that directory
- `~` — Claude sees your global `~/.claude/CLAUDE.md` and can access anything in your home directory
- Set to BAREclaw's own directory for self-modification

## Authentication

BAREclaw has shell access. Every channel that can reach it can run arbitrary commands.

- **HTTP**: set `BARECLAW_HTTP_TOKEN` for anything beyond localhost. Requests without `Authorization: Bearer <token>` get 401.
- **Telegram**: `BARECLAW_ALLOWED_USERS` is mandatory — BAREclaw refuses to start without it. Messages from users not on the allowlist are silently dropped.
- All channels share the same `--allowedTools` set (no per-channel restrictions in V1).

## Self-restart

BAREclaw can restart itself to pick up code changes:

- `POST /restart` — HTTP endpoint
- `kill -HUP <pid>` — SIGHUP signal
- Claude can trigger either via Bash

On restart: all session hosts killed, HTTP server closed, new detached process spawned with same args. ~1-2s downtime.

## Heartbeat

BAREclaw includes a heartbeat system — a scheduled job that fires hourly on a dedicated `"heartbeat"` channel. Works on both macOS (launchd) and Linux (systemd user timer). The server and heartbeat keep each other alive:

- **Server startup** automatically installs the heartbeat job (idempotent, runs `heartbeat/install.sh`).
- **Each heartbeat tick** checks if the server is running. If not, it starts it via `npm run dev` before sending the heartbeat message.

Start the server once, and it stays alive. Server crashes? Next hourly heartbeat restarts it. Heartbeat job gets unloaded? Next server start reinstalls it.

The heartbeat session is persistent and separate from all user-facing channels. It accumulates context — you can message it directly to add reminders or recurring checks:

```bash
curl -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "Every heartbeat, check if there are any new files in ~/Downloads that need organizing", "channel": "heartbeat"}'
```

### Files

```
heartbeat/
  heartbeat.sh                    # Runner: checks server health, starts if needed, sends heartbeat
  install.sh                      # Detects OS, installs the appropriate scheduled job
  com.bareclaw.heartbeat.plist    # macOS launchd template
  bareclaw-heartbeat.service      # Linux systemd oneshot service
  bareclaw-heartbeat.timer        # Linux systemd timer (1h interval)
```

### Manual install

Normally the server handles this automatically. To install manually:

```bash
bash heartbeat/install.sh
```

### Uninstall

**macOS:**
```bash
launchctl unload ~/Library/LaunchAgents/com.bareclaw.heartbeat.plist
rm ~/Library/LaunchAgents/com.bareclaw.heartbeat.plist
```

**Linux:**
```bash
systemctl --user disable --now bareclaw-heartbeat.timer
rm ~/.config/systemd/user/bareclaw-heartbeat.{service,timer}
systemctl --user daemon-reload
```

### Customize

Edit `heartbeat/heartbeat.sh` to change the heartbeat message. Edit the interval in the plist (`StartInterval` in seconds) or timer (`OnUnitActiveSec`). Re-run `install.sh` or restart the server to apply.

Logs: `/tmp/bareclaw-heartbeat.log`.

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot. Copy the token.
2. Get your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).
3. Set environment variables:
   ```bash
   BARECLAW_TELEGRAM_TOKEN=123456:ABC-DEF...
   BARECLAW_ALLOWED_USERS=your_user_id
   ```
4. Start BAREclaw. The bot connects via long polling — no public URL needed.

## Build

```bash
npm run build   # compile to dist/
npm start       # run compiled JS
```

## Why not the Agent SDK?

The Claude Agent SDK bills per API token — every prompt and response is metered. BAREclaw shells out to `claude -p` instead, which routes through the **Claude Max subscription** (flat-rate unlimited). For a personal daemon that fields dozens of prompts a day, the marginal API cost is $0.

The tradeoff: you depend on the CLI's IPC protocol (stream-JSON over stdio), which is less stable than a versioned SDK API. For a personal tool, this is fine.
