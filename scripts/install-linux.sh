#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-$HOME/.local/share/spinny-local-minimal}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/spinny-local-minimal.service"

mkdir -p "$INSTALL_DIR" "$SERVICE_DIR"
cp -R "$(cd "$(dirname "$0")/.." && pwd)/." "$INSTALL_DIR"

cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Spinny Local Minimal

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=npm start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable --now spinny-local-minimal.service
echo "Installed Spinny Local Minimal to $INSTALL_DIR"
