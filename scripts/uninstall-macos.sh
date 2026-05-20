#!/usr/bin/env bash
# Spinny Local Node — macOS uninstaller
#
# Removes the app completely but PRESERVES your encrypted vault (~/.spinny-local/).
# You can reinstall anytime and your data will be restored automatically.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/uninstall-macos.sh)
set -euo pipefail

INSTALL_DIR="$HOME/.spinny/node"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/au.spinny.local-node.plist"
SERVICE_LABEL="au.spinny.local-node"
DATA_DIR="$HOME/.spinny-local"
SHORTCUT=""

R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m'
B='\033[1m' DIM='\033[2m' RST='\033[0m'

step() { echo -e "\n${C}${B}▶ $1${RST}"; }
ok()   { echo -e "${G}✓ $1${RST}"; }
warn() { echo -e "${Y}⚠ $1${RST}"; }

echo ""
echo -e "${Y}${B}  Spinny Local Node — Uninstaller${RST}"
echo -e "${DIM}  This will remove the Spinny app but KEEP your encrypted data.${RST}"
echo ""
echo -e "  ${B}Will be removed:${RST}"
echo -e "    • App files    → ${INSTALL_DIR}"
echo -e "    • Launch agent → ${PLIST}"
echo ""
echo -e "  ${B}Will be preserved:${RST}"
echo -e "    • Vault & state → ${DATA_DIR}  ${G}(AES-256 encrypted)${RST}"
echo ""
read -r -p "  Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

# 1. Stop & remove launchd service
step "Stopping Spinny service"
launchctl unload "$PLIST" 2>/dev/null && ok "Service unloaded" || warn "Service was not running"
rm -f "$PLIST" && ok "Launch agent removed" || true

# 2. Kill any stray node processes
pkill -f "spinny-local-minimal" 2>/dev/null || true
pkill -f "SpinnyLocalMinimal" 2>/dev/null || true

# 3. Remove app directory
step "Removing app files"
if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR"
else
  warn "Install directory not found — already removed?"
fi

# 4. Remove parent ~/.spinny if empty
rmdir "$HOME/.spinny" 2>/dev/null || true

# 5. Summary
echo ""
echo -e "${DIM}================================================================${RST}"
echo -e "  ${G}${B}✓ Spinny Local Node removed${RST}"
echo ""
echo -e "  Your encrypted vault is intact at:"
echo -e "  ${B}${DATA_DIR}${RST}"
echo ""
echo -e "  ${DIM}Files in this directory are AES-256 encrypted with a key derived${RST}"
echo -e "  ${DIM}from your hardware. They are unreadable without your machine.${RST}"
echo -e "  ${DIM}Reinstall anytime — your history and credentials restore automatically.${RST}"
echo ""
echo -e "  To also erase all data (irreversible):"
echo -e "    ${R}rm -rf ${DATA_DIR}${RST}"
echo -e "${DIM}================================================================${RST}"
echo ""
