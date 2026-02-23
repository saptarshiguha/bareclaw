#!/bin/bash
# BAREclaw heartbeat runner.
# Called by launchd on a schedule. Ensures the server is running,
# then sends a heartbeat message to the "heartbeat" channel.

BARECLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BARECLAW_PORT="${BARECLAW_PORT:-3000}"
BARECLAW_URL="http://localhost:$BARECLAW_PORT"
LOG="/tmp/bareclaw-heartbeat.log"

# Load token from .env if available
BARECLAW_HTTP_TOKEN=""
if [ -f "$BARECLAW_DIR/.env" ]; then
  BARECLAW_HTTP_TOKEN=$(grep -E '^BARECLAW_HTTP_TOKEN=' "$BARECLAW_DIR/.env" | cut -d= -f2-)
fi

# Build auth args for curl
AUTH_ARGS=()
if [ -n "$BARECLAW_HTTP_TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $BARECLAW_HTTP_TOKEN")
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Check if server is responding
server_alive() {
  curl -sf -o /dev/null --max-time 5 "$BARECLAW_URL/message" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"text":"ping","channel":"__healthcheck"}' 2>/dev/null
  # Even a 400/500 means the server is up — curl -f only fails on HTTP errors
  # but a connection refused means it's down. Check if port is open instead.
  curl -sf -o /dev/null --max-time 3 "$BARECLAW_URL/" 2>/dev/null
  return $?
}

# Start the server if it's not running
if ! server_alive; then
  log "Server not responding, starting BAREclaw..."
  cd "$BARECLAW_DIR"

  # Use npm run dev in the background. Detach so launchd doesn't track it.
  nohup npm run dev >> /tmp/bareclaw-server.log 2>&1 &
  SERVER_PID=$!
  log "Started server (pid $SERVER_PID), waiting for it to come up..."

  # Wait up to 30s for the server to start
  for i in $(seq 1 30); do
    if server_alive; then
      log "Server is up after ${i}s"
      break
    fi
    sleep 1
  done

  if ! server_alive; then
    log "ERROR: Server failed to start after 30s"
    exit 1
  fi
fi

# Send heartbeat
log "Sending heartbeat..."
RESPONSE=$(curl -sf --max-time 300 -X POST "$BARECLAW_URL/message" \
  -H 'Content-Type: application/json' \
  "${AUTH_ARGS[@]}" \
  -d '{"text":"Heartbeat. Check if anything needs attention — pending tasks, reminders, scheduled work. If something needs the user'\''s attention, use POST /send to push a message to their Telegram. If nothing, just acknowledge briefly.","channel":"heartbeat"}' 2>&1)

if [ $? -eq 0 ]; then
  log "Heartbeat OK"
else
  log "Heartbeat failed: $RESPONSE"
fi
