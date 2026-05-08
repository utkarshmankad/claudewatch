#!/usr/bin/env bash
# Install ClaudeWatch as a systemd user unit on Linux.
#
# Usage:
#   bash scripts/install-daemon-linux.sh [NODE_BIN] [CW_BIN]
#
# When called from the npm postinstall hook the two arguments are injected
# automatically.  When run standalone they fall back to auto-detection.
#
# Uninstall:
#   systemctl --user disable --now claudewatch
#   rm ~/.config/systemd/user/claudewatch.service
#   systemctl --user daemon-reload

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve executables
# ---------------------------------------------------------------------------

NODE_BIN="${1:-}"
CW_BIN="${2:-}"

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [[ -z "$CW_BIN" ]]; then
  CW_BIN="$(command -v claudewatch 2>/dev/null || true)"
fi
if [[ -z "$CW_BIN" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CW_BIN="$(dirname "$SCRIPT_DIR")/bin/claudewatch.js"
fi

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "[claudewatch] ERROR: Node.js not found. Ensure 'node' is on PATH or pass its" >&2
  echo "             absolute path as the first argument to this script." >&2
  exit 1
fi

if [[ ! -f "$CW_BIN" ]]; then
  echo "[claudewatch] ERROR: claudewatch entry-point not found: $CW_BIN" >&2
  exit 1
fi

if ! command -v systemctl &>/dev/null; then
  echo "[claudewatch] ERROR: systemctl not found. This script requires systemd." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

HOME_DIR="${HOME:-$(eval echo ~)}"
DATA_DIR="$HOME_DIR/.claudewatch"
CONFIG_FILE="$DATA_DIR/config.toml"
LOG_FILE="$DATA_DIR/daemon.log"
SYSTEMD_DIR="$HOME_DIR/.config/systemd/user"
UNIT_FILE="$SYSTEMD_DIR/claudewatch.service"
NODE_DIR="$(dirname "$NODE_BIN")"

# ---------------------------------------------------------------------------
# Prepare directories
# ---------------------------------------------------------------------------

mkdir -p "$DATA_DIR" "$SYSTEMD_DIR"

# ---------------------------------------------------------------------------
# Stop and disable any existing unit (idempotent reinstall)
# ---------------------------------------------------------------------------

if systemctl --user is-active --quiet claudewatch 2>/dev/null; then
  echo "[claudewatch] Stopping existing service..."
  systemctl --user stop claudewatch 2>/dev/null || true
fi
systemctl --user disable claudewatch 2>/dev/null || true

# ---------------------------------------------------------------------------
# Write the unit file
#
# Restart=on-failure combined with the daemon exiting 0 when unconfigured
# (see src/daemon/index.ts) means no restart loop before 'claudewatch setup'.
# StartLimitBurst is a secondary safety net: if somehow the daemon exits 1
# five times in five minutes, systemd stops retrying until the user intervenes.
# ---------------------------------------------------------------------------

cat > "$UNIT_FILE" << UNIT_EOF
[Unit]
Description=ClaudeWatch — Anthropic API usage monitor
Documentation=https://github.com/anthropics/claudewatch
After=network-online.target
Wants=network-online.target

# Do not attempt to start if the config file has never been created.
# After 'claudewatch setup', run: systemctl --user start claudewatch
ConditionPathExists=${CONFIG_FILE}

# Secondary safety net: stop retrying after 5 failures in 5 minutes.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${NODE_BIN} ${CW_BIN} daemon
Restart=on-failure
RestartSec=30

StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

# Expose the user's home and a PATH that includes the node binary directory.
Environment=HOME=${HOME_DIR}
Environment=NODE_ENV=production
Environment=PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

# Run as a low-priority background task.
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
UNIT_EOF

echo "[claudewatch] Unit written → $UNIT_FILE"

# ---------------------------------------------------------------------------
# Reload systemd and enable the unit
# ---------------------------------------------------------------------------

systemctl --user daemon-reload
systemctl --user enable claudewatch
echo "[claudewatch] Service enabled (claudewatch.service)"

# ---------------------------------------------------------------------------
# Enable linger so the user's systemd instance (and this service) starts
# at boot even before the user logs in interactively.
# ---------------------------------------------------------------------------

if command -v loginctl &>/dev/null; then
  loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || true
  echo "[claudewatch] Linger enabled  (daemon will start at boot)"
fi

# ---------------------------------------------------------------------------
# Start now if config exists; otherwise tell the user what to do next.
# ---------------------------------------------------------------------------

if [[ -f "$CONFIG_FILE" ]]; then
  systemctl --user start claudewatch
  echo "[claudewatch] Service started"
else
  echo ""
  echo "  ConditionPathExists: $CONFIG_FILE (not found)"
  echo "  The service is enabled but will not start until setup is complete."
  echo ""
  echo "  Next steps:"
  echo "    claudewatch setup                   # configure API key + thresholds"
  echo "    systemctl --user start claudewatch  # start the daemon"
  echo "    claudewatch status                  # view usage"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "  Unit file  : $UNIT_FILE"
echo "  Log file   : $LOG_FILE"
echo ""
echo "  Useful commands:"
echo "    systemctl --user status claudewatch   # service status"
echo "    journalctl --user -u claudewatch -f   # follow logs"
echo "    claudewatch health                    # daemon + DB diagnostics"
echo ""
echo "  Uninstall:"
echo "    systemctl --user disable --now claudewatch"
echo "    rm \"$UNIT_FILE\""
echo "    systemctl --user daemon-reload"
echo ""
