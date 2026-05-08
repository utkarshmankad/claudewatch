#!/usr/bin/env bash
# Install ClaudeWatch as a launchd user agent on macOS.
#
# Usage:
#   bash scripts/install-daemon-macos.sh [NODE_BIN] [CW_BIN]
#
# When called from the npm postinstall hook the two arguments are injected
# automatically.  When run standalone they fall back to auto-detection.
#
# Uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.claudewatch.daemon.plist
#   rm ~/Library/LaunchAgents/com.claudewatch.daemon.plist

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve executables
# ---------------------------------------------------------------------------

NODE_BIN="${1:-}"
CW_BIN="${2:-}"

# Auto-detect node if not supplied
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

# Auto-detect claudewatch.js if not supplied.
# During 'npm install -g' the bin symlink does not exist yet, so we derive
# the path from this script's own location (scripts/ → package root → bin/).
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

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

HOME_DIR="${HOME:-$(eval echo ~)}"
DATA_DIR="$HOME_DIR/.claudewatch"
CONFIG_FILE="$DATA_DIR/config.toml"
LOG_FILE="$DATA_DIR/daemon.log"
PLIST_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_LABEL="com.claudewatch.daemon"
PLIST_FILE="$PLIST_DIR/$PLIST_LABEL.plist"
NODE_DIR="$(dirname "$NODE_BIN")"

# ---------------------------------------------------------------------------
# Prepare directories
# ---------------------------------------------------------------------------

mkdir -p "$DATA_DIR" "$PLIST_DIR"

# ---------------------------------------------------------------------------
# Unload any existing service (idempotent reinstall)
# ---------------------------------------------------------------------------

if launchctl list "$PLIST_LABEL" &>/dev/null; then
  echo "[claudewatch] Unloading existing service..."
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Write the plist
#
# KeepAlive/PathState watches config.toml via kqueue:
#   - Config absent → daemon is not started (no loop while unconfigured).
#   - Config appears (after 'claudewatch setup') → launchd starts the daemon.
#   - Config present + daemon crashes → launchd restarts after ThrottleInterval.
# ---------------------------------------------------------------------------

cat > "$PLIST_FILE" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>

  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CW_BIN}</string>
    <string>daemon</string>
  </array>

  <!--
    Start immediately at load if config.toml exists (covers reinstall with
    an existing config), and restart on crash only while config.toml is present.
    When the file does not exist the daemon is not started — no restart loop.
    launchd watches the path via kqueue and auto-starts when the file appears.
  -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${CONFIG_FILE}</key>
      <true/>
    </dict>
  </dict>

  <!-- Minimum seconds between automatic restarts on crash -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>

  <key>WorkingDirectory</key>
  <string>${HOME_DIR}</string>

  <!-- Run as a low-priority background task -->
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME_DIR}</string>
    <!--
      Include the node binary's directory so child processes spawned by the
      daemon can find node.  Also adds Homebrew paths for Apple Silicon Macs.
    -->
    <key>PATH</key>
    <string>${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

</dict>
</plist>
PLIST_EOF

echo "[claudewatch] Plist written → $PLIST_FILE"

# ---------------------------------------------------------------------------
# Load the agent
# ---------------------------------------------------------------------------

launchctl load -w "$PLIST_FILE"
echo "[claudewatch] Service loaded  (${PLIST_LABEL})"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "  launchd agent : $PLIST_LABEL"
echo "  Plist file    : $PLIST_FILE"
echo "  Log file      : $LOG_FILE"
echo ""
if [[ -f "$CONFIG_FILE" ]]; then
  echo "  Config found — daemon should be starting now."
  echo "  Check status:  claudewatch health"
else
  echo "  Next steps:"
  echo "    claudewatch setup    # configure API key + thresholds"
  echo "    claudewatch status   # view usage after setup"
  echo ""
  echo "  The daemon will start automatically once setup is complete."
fi
echo ""
echo "  Uninstall:"
echo "    launchctl unload \"$PLIST_FILE\""
echo "    rm \"$PLIST_FILE\""
echo ""
