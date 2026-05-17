#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-$HOME/Library/Application Support/SpinnyLocalMinimal}"
PLIST="$HOME/Library/LaunchAgents/au.spinny.local-minimal.plist"

mkdir -p "$INSTALL_DIR"
cp -R "$(cd "$(dirname "$0")/.." && pwd)/." "$INSTALL_DIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>au.spinny.local-minimal</string>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>npm</string><string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$INSTALL_DIR/spinny-local.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_DIR/spinny-local.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed Spinny Local Minimal to $INSTALL_DIR"
