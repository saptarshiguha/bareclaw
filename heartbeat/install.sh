#!/bin/bash
# Install the BAREclaw heartbeat scheduled job.
# macOS: launchd plist in ~/Library/LaunchAgents/
# Linux: systemd user timer in ~/.config/systemd/user/
# Safe to call repeatedly — idempotent.

set -euo pipefail

HEARTBEAT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEARTBEAT_SCRIPT="$HEARTBEAT_DIR/heartbeat.sh"

if [ ! -f "$HEARTBEAT_SCRIPT" ]; then
  echo "Error: $HEARTBEAT_SCRIPT not found"
  exit 1
fi

chmod +x "$HEARTBEAT_SCRIPT"

OS="$(uname -s)"

case "$OS" in
  Darwin)
    PLIST_TEMPLATE="$HEARTBEAT_DIR/com.bareclaw.heartbeat.plist"
    PLIST_DST="$HOME/Library/LaunchAgents/com.bareclaw.heartbeat.plist"

    if [ ! -f "$PLIST_TEMPLATE" ]; then
      echo "Error: $PLIST_TEMPLATE not found"
      exit 1
    fi

    mkdir -p "$HOME/Library/LaunchAgents"

    # Unload if already installed
    if launchctl list 2>/dev/null | grep -q com.bareclaw.heartbeat; then
      launchctl unload "$PLIST_DST" 2>/dev/null || true
    fi

    # Template the plist with the absolute path to heartbeat.sh
    sed "s|__HEARTBEAT_SCRIPT__|$HEARTBEAT_SCRIPT|g" "$PLIST_TEMPLATE" > "$PLIST_DST"
    launchctl load "$PLIST_DST"

    echo "[heartbeat] Installed (launchd). Fires every hour."
    echo "[heartbeat] Script: $HEARTBEAT_SCRIPT"
    echo "[heartbeat] Uninstall: launchctl unload $PLIST_DST && rm $PLIST_DST"
    ;;

  Linux)
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    SERVICE_TEMPLATE="$HEARTBEAT_DIR/bareclaw-heartbeat.service"
    TIMER_TEMPLATE="$HEARTBEAT_DIR/bareclaw-heartbeat.timer"

    if [ ! -f "$SERVICE_TEMPLATE" ] || [ ! -f "$TIMER_TEMPLATE" ]; then
      echo "Error: systemd unit files not found in $HEARTBEAT_DIR"
      exit 1
    fi

    mkdir -p "$SYSTEMD_DIR"

    # Template and install service
    sed "s|__HEARTBEAT_SCRIPT__|$HEARTBEAT_SCRIPT|g" "$SERVICE_TEMPLATE" > "$SYSTEMD_DIR/bareclaw-heartbeat.service"
    cp "$TIMER_TEMPLATE" "$SYSTEMD_DIR/bareclaw-heartbeat.timer"

    # Reload and enable
    systemctl --user daemon-reload
    systemctl --user enable --now bareclaw-heartbeat.timer

    echo "[heartbeat] Installed (systemd). Fires every hour."
    echo "[heartbeat] Script: $HEARTBEAT_SCRIPT"
    echo "[heartbeat] Status: systemctl --user status bareclaw-heartbeat.timer"
    echo "[heartbeat] Uninstall: systemctl --user disable --now bareclaw-heartbeat.timer"
    ;;

  *)
    echo "Error: unsupported platform '$OS'. Only macOS (launchd) and Linux (systemd) are supported."
    exit 1
    ;;
esac

echo "[heartbeat] Logs: /tmp/bareclaw-heartbeat.log"
