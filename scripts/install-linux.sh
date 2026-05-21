#!/usr/bin/env bash
# Spinny Local Node — Linux installer
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/install-linux.sh)
#
# Fresh install (wipes state, re-pairs):
#   bash <(curl -fsSL .../install-linux.sh) --fresh
#
# Update only (keeps pairing):
#   bash <(curl -fsSL .../install-linux.sh) --update
#
# Headless server (auto-installs + connects Tailscale for remote access):
#   bash <(curl -fsSL .../install-linux.sh) --headless
set -euo pipefail

REPO_URL="https://github.com/spinny-au/spinny-local-minimal.git"
INSTALL_DIR="$HOME/.local/share/spinny-local-minimal"
STATE_DIR="$HOME/.spinny-local"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/spinny-local-minimal.service"
SERVICE_NAME="spinny-local-minimal"
NODE_PORT=47821
CONTROL_URL="https://spinny.au"

FRESH=false; UPDATE=false; HEADLESS=false
for arg in "$@"; do
  [[ "$arg" == "--fresh"    ]] && FRESH=true
  [[ "$arg" == "--update"   ]] && UPDATE=true
  [[ "$arg" == "--headless" ]] && HEADLESS=true
done

# ── Colours ───────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m'
B='\033[1m' DIM='\033[2m' RST='\033[0m'

step() { echo -e "\n${C}${B}▶ $1${RST}"; }
ok()   { echo -e "${G}✓ $1${RST}"; }
warn() { echo -e "${Y}⚠ $1${RST}"; }
fail() { echo -e "${R}✗ $1${RST}"; exit 1; }

print_rainbow() {
  local line="$1" idx="${2:-0}"
  local cols=(31 33 32 36 34 35)
  local col=${cols[$((idx % 6))]}
  echo -e "\033[1;${col}m${line}\033[0m"
}

# ── 1. Node.js 22 ─────────────────────────────────────────────────────────────
step "Checking Node.js"
install_node() {
  # Try nvm first (fastest, no sudo)
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm install 22 --silent && nvm use 22 --silent && return
  fi

  # Detect package manager
  if command -v apt-get &>/dev/null; then
    warn "Installing Node.js 22 via NodeSource (apt)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
    sudo apt-get install -y nodejs >/dev/null 2>&1
  elif command -v dnf &>/dev/null; then
    warn "Installing Node.js 22 via NodeSource (dnf)"
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - >/dev/null 2>&1
    sudo dnf install -y nodejs >/dev/null 2>&1
  elif command -v yum &>/dev/null; then
    warn "Installing Node.js 22 via NodeSource (yum)"
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - >/dev/null 2>&1
    sudo yum install -y nodejs >/dev/null 2>&1
  elif command -v pacman &>/dev/null; then
    warn "Installing Node.js via pacman"
    sudo pacman -S --noconfirm nodejs npm >/dev/null 2>&1
  else
    # Install nvm as fallback
    warn "Installing nvm to get Node.js 22"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >/dev/null 2>&1
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
    nvm install 22 --silent && nvm use 22 --silent
  fi
}

if node --version 2>/dev/null | grep -qE '^v2[2-9]'; then
  ok "Node.js $(node --version) already installed"
else
  install_node
  ok "Node.js $(node --version) installed"
fi

# ── 2. Git ────────────────────────────────────────────────────────────────────
step "Checking Git"
if command -v git &>/dev/null; then
  ok "$(git --version)"
else
  if command -v apt-get &>/dev/null; then sudo apt-get install -y git >/dev/null 2>&1
  elif command -v dnf &>/dev/null; then sudo dnf install -y git >/dev/null 2>&1
  elif command -v yum &>/dev/null; then sudo yum install -y git >/dev/null 2>&1
  elif command -v pacman &>/dev/null; then sudo pacman -S --noconfirm git >/dev/null 2>&1
  else fail "Git not found and no known package manager. Install git and re-run."
  fi
  ok "$(git --version)"
fi

# ── 3. Ollama ─────────────────────────────────────────────────────────────────
step "Checking Ollama"
OLLAMA_RUNNING=false; OLLAMA_MODELS=()
if command -v ollama &>/dev/null; then
  ok "Ollama already installed"
else
  step "Installing Ollama"
  curl -fsSL https://ollama.com/install.sh | sh >/dev/null 2>&1
  ok "Ollama installed"
fi

if ollama list &>/dev/null; then
  OLLAMA_RUNNING=true
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == NAME* ]] && continue
    OLLAMA_MODELS+=("$(echo "$line" | awk '{print $1}')")
  done < <(ollama list 2>/dev/null | tail -n +2)
fi

# ── 4. Fresh / Update ─────────────────────────────────────────────────────────
if $FRESH; then
  step "Fresh install — wiping previous installation"
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  pkill -f "spinny-local-minimal" 2>/dev/null || true
  rm -rf "$INSTALL_DIR" "$STATE_DIR"
  ok "Wiped"
fi

if $UPDATE && [[ ! -d "$INSTALL_DIR/.git" ]]; then
  fail "No existing install at $INSTALL_DIR — run without --update first"
fi

# ── 5. Clone / pull ───────────────────────────────────────────────────────────
step "Setting up Spinny Local Node"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  git -C "$INSTALL_DIR" pull --ff-only
  ok "Updated to latest"
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned"
fi

# ── 6. Dependencies ───────────────────────────────────────────────────────────
step "Installing npm dependencies"
npm install --prefix "$INSTALL_DIR" --omit=dev --silent
ok "Dependencies ready"

# ── 7. .env ───────────────────────────────────────────────────────────────────
step "Writing .env"
ENV_FILE="$INSTALL_DIR/.env"
EXISTING_TOKEN=""
[[ -f "$ENV_FILE" ]] && EXISTING_TOKEN=$(grep -oE 'SPINNY_DASHBOARD_TOKEN=\S+' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
DASH_TOKEN="${EXISTING_TOKEN:-$(openssl rand -base64 33 | tr -d '/+=\n' | head -c 44)}"

{
  echo "# Auto-generated by install-linux.sh — do not commit"
  echo "SPINNY_CONTROL_URL=$CONTROL_URL"
  echo "SPINNY_BIND_HOST=0.0.0.0"
  echo "SPINNY_DASHBOARD_TOKEN=${DASH_TOKEN}"
  echo "SPINNY_ALLOW_INSECURE_FILE_KEY=1"
} > "$ENV_FILE"
ok ".env written"

# ── 8. systemd user service ───────────────────────────────────────────────────
step "Installing systemd user service"
NODE_BIN=$(command -v node)
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Spinny Local Node
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} --experimental-sqlite --no-warnings --env-file-if-exists=.env src/main.js start
Restart=on-failure
RestartSec=5
StandardOutput=append:${INSTALL_DIR}/spinny-local.log
StandardError=append:${INSTALL_DIR}/spinny-local.log

[Install]
WantedBy=default.target
UNIT

# Enable lingering so the service survives logout
loginctl enable-linger "$(whoami)" 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" 2>/dev/null || true
systemctl --user restart "$SERVICE_NAME"
ok "Service started (runs at login)"

# ── 9. Wait for pairing code ──────────────────────────────────────────────────
step "Waiting for node to initialise"
STATE_FILE="$STATE_DIR/state.json"
PAIRING_CODE=""; PAIRED=false
for i in $(seq 1 30); do
  sleep 1
  [[ ! -f "$STATE_FILE" ]] && continue
  CODE=$(grep -oP '(?<="pairingCode":")[^"]+' "$STATE_FILE" 2>/dev/null || true)
  IS_PAIRED=$(grep -oP '(?<="paired":)true' "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$IS_PAIRED" ]] && PAIRED=true && break
  [[ -n "$CODE" ]] && PAIRING_CODE="$CODE" && break
done
[[ -z "$PAIRING_CODE" && "$PAIRED" == "false" ]] && PAIRING_CODE="run: journalctl --user -u ${SERVICE_NAME} -n 50"

# ── 10. Tailscale ─────────────────────────────────────────────────────────────
TAILSCALE_STR="Not installed"
if $HEADLESS; then
  step "Installing Tailscale (headless mode)"
  if ! command -v tailscale &>/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
    ok "Tailscale installed"
  else
    ok "Tailscale already installed"
  fi
  # Bring up tailscale in auth mode — user will need to auth via printed URL
  if tailscale status &>/dev/null 2>&1; then
    TAILSCALE_IP=$(tailscale ip --4 2>/dev/null || echo '')
    if [[ -n "$TAILSCALE_IP" ]]; then
      TAILSCALE_STR="● Connected  •  $TAILSCALE_IP"
      ok "Tailscale connected: $TAILSCALE_IP"
    else
      sudo tailscale up --accept-routes 2>/dev/null || true
      TAILSCALE_IP=$(tailscale ip --4 2>/dev/null || echo '')
      TAILSCALE_STR="● Connected  •  ${TAILSCALE_IP:-pending auth}"
    fi
  else
    warn "Tailscale installed but not authenticated — run: sudo tailscale up"
    TAILSCALE_STR="○ Installed — run: sudo tailscale up"
  fi
else
  if command -v tailscale &>/dev/null; then
    TAILSCALE_IP=$(tailscale ip --4 2>/dev/null || echo '')
    TAILSCALE_STR="${TAILSCALE_IP:+● Connected  •  $TAILSCALE_IP}${TAILSCALE_IP:-○ Installed (not connected)}"
  fi
fi

# ── 11. System info ───────────────────────────────────────────────────────────
CPU_COUNT=$(nproc 2>/dev/null || echo '?')
RAM_GB=$(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null || echo '?')
DISK_FREE=$(df -h "$INSTALL_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo '?')
GPU_INFO=$(lspci 2>/dev/null | grep -i 'vga\|3d\|display' | head -1 | sed 's/.*: //' || echo 'No GPU info')
NODE_VER=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo '?')
SVC_OK=$(systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null && echo true || echo false)
STATUS_STR=$( $SVC_OK && echo "● Running" || echo "○ Not running — run: systemctl --user start ${SERVICE_NAME}")
OLLAMA_STR=$($OLLAMA_RUNNING && echo "● Running  •  ${#OLLAMA_MODELS[@]} model(s)" || echo "○ Not running")
BRAIN="${OLLAMA_MODELS[0]:-no model installed yet}"
GIT_STR="✓ $(git --version)  (updates: re-run install-linux.sh)"

PORT_OK=false
curl -sf --max-time 3 "http://localhost:${NODE_PORT}/health" >/dev/null 2>&1 && PORT_OK=true

# ── 12. Banner ────────────────────────────────────────────────────────────────
clear

LOGO=(
'    /$$$$$$  /$$$$$$$  /$$$$$$ /$$   /$$ /$$   /$$ /$$     /$$'
'   /$$__  $$| $$__  $$|_  $$_/| $$$ | $$| $$$ | $$|  $$   $$/ '
'  | $$  \__/| $$  \ $$  | $$  | $$$$| $$| $$$$| $$ \  $$ /$$/ '
'  |  $$$$$$ | $$$$$$$/  | $$  | $$ $$ $$| $$ $$ $$  \  $$$$/ '
'   \____  $$| $$____/   | $$  | $$  $$$$| $$  $$$$   \  $$/ '
'   /$$  \ $$| $$        | $$  | $$\  $$$| $$\  $$$    | $$   '
'  |  $$$$$$/| $$       /$$$$$$| $$ \  $$| $$ \  $$    | $$   '
'   \______/ |__/      |______/|__/  \__/|__/  \__/    |__/  '
)

LINE='===================================================================='

echo ""
echo -e "${Y}${B}  ↓  ↓  ↓  ↓  ↓  ↓  ↓   IMPORTANT — COPY & STORE   ↓  ↓  ↓  ↓  ↓  ↓  ↓${RST}"
echo -e "${DIM}${LINE}${RST}"
for i in "${!LOGO[@]}"; do print_rainbow "${LOGO[$i]}" $i; done
echo -e "${DIM}${LINE}${RST}"
echo -e "  🚀  ${B}SPINNY LOCAL NODE  v${NODE_VER}  SUCCESSFULLY INSTALLED${RST}  🚀"
echo -e "${DIM}--------------------------------------------------------------------${RST}"
echo ""
printf "  %-18s: %s vCPUs  •  %s  •  %s  •  %s free\n" "Hardware"  "$CPU_COUNT" "$RAM_GB" "$GPU_INFO" "$DISK_FREE"
printf "  %-18s: %s\n"                                   "Ollama"    "$OLLAMA_STR"
printf "  %-18s: %s\n"                                   "Brain"     "$BRAIN"
printf "  %-18s: %s\n"                                   "Status"    "$STATUS_STR"
[[ "$TAILSCALE_STR" != "Not installed" ]] && printf "  %-18s: %s\n" "Tailscale" "$TAILSCALE_STR"
echo ""
printf "  %-18s: http://localhost:%s\n" "Node UI" "$NODE_PORT"
echo ""
if $PAIRED; then
  printf "  %-18s: already paired ✓\n" "Pairing"
else
  printf "  %-18s: %s\n" "Pairing code" "$PAIRING_CODE"
  echo -e "                       ${DIM}Enter this at spinny.au → Settings → Local Node${RST}"
fi
echo ""
printf "  %-18s: " "Dashboard token"
echo -e "${Y}${B}${DASH_TOKEN}${RST}"
echo -e "                       ${DIM}${ENV_FILE}${RST}"
echo ""
printf "  %-18s: %s\n" "Git" "$GIT_STR"
echo ""
echo -e "${DIM}--------------------------------------------------------------------${RST}"
if $PORT_OK; then
  echo -e "  ${G}${B}✓ Port ${NODE_PORT} reachable on localhost${RST}"
else
  echo -e "  ${Y}○ Port ${NODE_PORT} not yet reachable — node is still starting${RST}"
fi
echo -e "${DIM}${LINE}${RST}"
echo -e "  Node is ready. Open ${B}spinny.au${RST} and enter your pairing code."
echo -e "${DIM}${LINE}${RST}"
echo ""
