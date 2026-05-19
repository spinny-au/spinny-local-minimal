#!/usr/bin/env bash
# Spinny Local Node — Ubuntu auto-installer
# Usage: bash install.sh
set -euo pipefail

REPO_URL="https://github.com/spinny-au/spinny-local-minimal.git"
INSTALL_DIR="$HOME/.spinny/node"
STATE_DIR="$HOME/.spinny-local"
CERT_DIR="$HOME/.spinny/certs"
SERVICE_NAME="spinny-local"
NODE_PORT=47821

# ── Colours ───────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m'
B='\033[1m' DIM='\033[2m' RST='\033[0m'

step() { echo -e "\n${C}${B}▶ $1${RST}"; }
ok()   { echo -e "${G}✓ $1${RST}"; }
warn() { echo -e "${Y}⚠ $1${RST}"; }

need_sudo() {
  [[ $EUID -eq 0 ]] && return
  sudo -n true 2>/dev/null && return
  echo "This installer needs sudo for system packages."
  sudo -v
}

# ── Rainbow print ─────────────────────────────────────────────────────────────
print_rainbow() {
  local line="$1" hue_base="${2:-0}" len=${#line}
  for ((i=0; i<len; i++)); do
    local char="${line:$i:1}"
    local hue=$(( (hue_base + i * 4) % 360 ))
    local sector=$(( hue / 60 )) frac=$(( hue % 60 * 255 / 60 ))
    local r g b
    case $sector in
      0) r=255; g=$frac;        b=0   ;;
      1) r=$((255-frac)); g=255; b=0   ;;
      2) r=0;   g=255;          b=$frac ;;
      3) r=0;   g=$((255-frac)); b=255 ;;
      4) r=$frac; g=0;          b=255 ;;
      *) r=255; g=0;            b=$((255-frac)) ;;
    esac
    printf "\e[1;38;2;%d;%d;%dm%s" $r $g $b "$char"
  done
  printf "\e[0m\n"
}

# ── 1. Node.js 22 ─────────────────────────────────────────────────────────────
step "Checking Node.js"
if node --version 2>/dev/null | grep -qE '^v2[2-9]'; then
  ok "Node.js $(node --version) already installed"
else
  step "Installing Node.js 22"
  need_sudo
  _setup=$(mktemp)
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$_setup"
  sudo bash "$_setup"
  rm -f "$_setup"
  sudo apt-get install -y nodejs 2>&1 | tail -3
  ok "Node.js $(node --version) installed"
fi

# ── 2. Ollama ─────────────────────────────────────────────────────────────────
step "Checking Ollama"
if command -v ollama &>/dev/null; then
  ok "Ollama already installed"
else
  step "Installing Ollama"
  curl -fsSL https://ollama.com/install.sh | sh
  ok "Ollama installed"
fi

if ! systemctl is-active --quiet ollama 2>/dev/null; then
  sudo systemctl enable ollama --now 2>/dev/null || (ollama serve &>/dev/null & sleep 2)
fi

OLLAMA_RUNNING=false
OLLAMA_MODELS=()
if ollama list &>/dev/null; then
  OLLAMA_RUNNING=true
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == NAME* ]] && continue
    OLLAMA_MODELS+=("$(echo "$line" | awk '{print $1}')")
  done < <(ollama list 2>/dev/null | tail -n +2)
fi

# ── 3. Firewall ───────────────────────────────────────────────────────────────
step "Configuring firewall"
if command -v ufw &>/dev/null; then
  if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    sudo ufw allow "$NODE_PORT/tcp" > /dev/null
    # Also allow on the Tailscale interface specifically — generic rules don't
    # always catch traffic arriving on tailscale0 on some Ubuntu versions
    sudo ufw allow in on tailscale0 to any port "$NODE_PORT" 2>/dev/null || true
    ok "UFW: port $NODE_PORT open (all interfaces + tailscale0)"
  else
    ok "UFW inactive — skipping"
  fi
else
  ok "No UFW — skipping"
fi

# ── 4. Tailscale ──────────────────────────────────────────────────────────────
step "Checking Tailscale"
TS_IP=""
TS_HOSTNAME=""
TS_HTTPS=false
TS_CERT_ERROR=""
if command -v tailscale &>/dev/null; then
  TS_IP=$(tailscale ip --4 2>/dev/null || tailscale ip 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)
  TS_HOSTNAME=$(tailscale status --json 2>/dev/null \
    | grep -o '"DNSName":"[^"]*"' | head -1 \
    | cut -d'"' -f4 | sed 's/\.$//' || true)

  if [[ -n "$TS_IP" ]]; then
    ok "Tailscale active — IP: $TS_IP"

    # Generate HTTPS cert via Tailscale
    if [[ -n "$TS_HOSTNAME" ]]; then
      step "Generating Tailscale HTTPS cert for $TS_HOSTNAME"
      mkdir -p "$CERT_DIR"
      if CERT_OUTPUT=$(sudo tailscale cert \
          --cert-file "$CERT_DIR/cert.pem" \
          --key-file  "$CERT_DIR/key.pem" \
          "$TS_HOSTNAME" 2>&1); then
        TS_HTTPS=true
        sudo chown "$USER:$(id -gn)" "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem" 2>/dev/null || true
        ok "TLS cert ready — node will serve HTTPS"
      else
        TS_CERT_ERROR="$CERT_OUTPUT"
        # Fallback: try without explicit flags (older tailscale versions)
        pushd "$CERT_DIR" > /dev/null
        if CERT_OUTPUT=$(sudo tailscale cert "$TS_HOSTNAME" 2>&1); then
          # Rename to standard names if needed
          mv "${TS_HOSTNAME}.crt" cert.pem 2>/dev/null || true
          mv "${TS_HOSTNAME}.key" key.pem  2>/dev/null || true
          sudo chown "$USER:$(id -gn)" cert.pem key.pem 2>/dev/null || true
          [[ -f cert.pem && -f key.pem ]] && TS_HTTPS=true
        else
          TS_CERT_ERROR="${TS_CERT_ERROR}"$'\n'"${CERT_OUTPUT}"
        fi
        popd > /dev/null
        if ! $TS_HTTPS; then
          warn "Could not generate Tailscale HTTPS cert - node will use HTTP"
          [[ -n "$TS_CERT_ERROR" ]] && echo "$TS_CERT_ERROR" | sed 's/^/  tailscale cert: /'
          warn "Run manually: sudo tailscale cert $TS_HOSTNAME"
          warn "Until HTTPS is enabled, pairing from spinny.au will fail because browsers block mixed-content requests."
        fi
        if $TS_HTTPS; then
          ok "TLS cert ready"
        fi
      fi
    fi
  else
    warn "Tailscale installed but not connected. Run: sudo tailscale up"
  fi
else
  echo -e "  ${DIM}Tailscale not installed. For remote access:${RST}"
  echo -e "  ${DIM}  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up${RST}"
fi

# ── 5. Clone / update ─────────────────────────────────────────────────────────
step "Setting up Spinny Local Node"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only
  ok "Updated to latest"
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned"
fi

# ── 6. npm install ────────────────────────────────────────────────────────────
step "Installing npm dependencies"
npm install --prefix "$INSTALL_DIR" --omit=dev --silent
ok "Dependencies ready"

# ── 7. .env ───────────────────────────────────────────────────────────────────
step "Writing .env"
ENV_FILE="$INSTALL_DIR/.env"

EXISTING_DASH_TOKEN=""
[[ -f "$ENV_FILE" ]] && EXISTING_DASH_TOKEN=$(grep -oP '(?<=SPINNY_DASHBOARD_TOKEN=)\S+' "$ENV_FILE" 2>/dev/null || true)
DASH_TOKEN="${EXISTING_DASH_TOKEN:-$(openssl rand -base64 33 | tr -d '/+=\n' | head -c 44)}"

{
  echo "# Auto-generated by install.sh — do not commit"
  echo "SPINNY_BIND_HOST=0.0.0.0"
  echo "SPINNY_DASHBOARD_TOKEN=${DASH_TOKEN}"
  echo "SPINNY_ALLOW_INSECURE_FILE_KEY=1"
  if $TS_HTTPS; then
    echo "SPINNY_TLS_CERT=${CERT_DIR}/cert.pem"
    echo "SPINNY_TLS_KEY=${CERT_DIR}/key.pem"
    echo "SPINNY_TLS_HOSTNAME=${TS_HOSTNAME}"
  fi
} > "$ENV_FILE"
ok ".env written"

# ── 8. systemd service ────────────────────────────────────────────────────────
step "Installing systemd service"
NODE_BIN=$(which node)
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=Spinny Local Node
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN --experimental-sqlite --no-warnings --env-file-if-exists=.env src/main.js start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=spinny-local

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" --quiet
sudo systemctl restart "$SERVICE_NAME"
ok "Service started"

# ── 9. Wait for state + collect info ──────────────────────────────────────────
step "Collecting system info"

# Retry up to 30s for the pairing code to appear in state.json
STATE_FILE="$STATE_DIR/state.json"
PAIRING_CODE=""
for i in $(seq 1 30); do
  sleep 1
  PAIRING_CODE=$(grep -oP '(?<="pairingCode":")[A-Z0-9]+' "$STATE_FILE" 2>/dev/null || true)
  [[ -n "$PAIRING_CODE" ]] && break
done

# Fallback: read pairing code directly from journal (service prints it on startup)
if [[ -z "$PAIRING_CODE" ]]; then
  PAIRING_CODE=$(journalctl -u "$SERVICE_NAME" --no-pager -n 100 2>/dev/null \
    | grep -oP 'Pairing code:\s+\K[A-Z0-9]+' | tail -1 || true)
fi
[[ -z "$PAIRING_CODE" ]] && PAIRING_CODE="run: journalctl -u spinny-local -f"

# Pull QR URL from journal
QR_URL=$(journalctl -u "$SERVICE_NAME" --no-pager -n 100 2>/dev/null \
  | grep -oP 'QR URL: \K\S+' | tail -1 || true)

CPU_COUNT=$(nproc 2>/dev/null || echo "?")
RAM_GB=$(awk '/MemTotal/{printf "%.2f GB", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "?")
DISK_FREE=$(df -h "$INSTALL_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo "?")
GPU_INFO=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "No GPU detected")

BRAIN="${OLLAMA_MODELS[0]:-no model installed}"
OLLAMA_STR="● Running  •  ${#OLLAMA_MODELS[@]} model(s)"
$OLLAMA_RUNNING || OLLAMA_STR="○ Not running"

PROTO="http"
$TS_HTTPS && PROTO="https"

if [[ -n "$TS_HOSTNAME" ]] && $TS_HTTPS; then
  NODE_UI_URL="https://${TS_HOSTNAME}:${NODE_PORT}"
elif [[ -n "$TS_IP" ]]; then
  NODE_UI_URL="http://${TS_IP}:${NODE_PORT}"
else
  NODE_UI_URL="http://localhost:${NODE_PORT}"
fi

SVC_OK=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo "inactive")
[[ "$SVC_OK" == "active" ]] \
  && STATUS_STR="● All services running" \
  || STATUS_STR="✗ Service not running — journalctl -u spinny-local"

NODE_VER=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo "?")

GIT_STATUS=""
command -v git &>/dev/null \
  && GIT_STATUS="✓ $(git --version)  (updates: re-run install.sh)" \
  || GIT_STATUS="✗ Not installed — required for updates"

# ── 10. Banner ────────────────────────────────────────────────────────────────
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
for i in "${!LOGO[@]}"; do print_rainbow "${LOGO[$i]}" $((i * 38)); done
echo -e "${DIM}${LINE}${RST}"
echo -e "  🚀  ${B}SPINNY LOCAL NODE  v${NODE_VER}  SUCCESSFULLY INSTALLED${RST}  🚀"
echo -e "${DIM}--------------------------------------------------------------------${RST}"
echo ""
printf "  %-18s: %s vCPUs  •  %s  •  %s  •  %s free\n" "Hardware"  "$CPU_COUNT" "$RAM_GB" "$GPU_INFO" "$DISK_FREE"
printf "  %-18s: %s\n"                                   "Ollama"    "$OLLAMA_STR"
printf "  %-18s: %s\n"                                   "Brain"     "$BRAIN"
printf "  %-18s: %s\n"                                   "Status"    "$STATUS_STR"
echo ""
printf "  %-18s: %s\n" "Node UI"  "$NODE_UI_URL"
printf "  %-18s: %s\n" "Local"    "http://localhost:${NODE_PORT}"
if [[ -n "$TS_IP" ]] && ! $TS_HTTPS; then
  echo -e "  ${Y}⚠ No HTTPS cert — pair via spinny.au will fail (mixed content). Re-run install.sh after fixing Tailscale cert.${RST}"
fi
echo ""
printf "  %-18s: %s\n" "Pairing code" "$PAIRING_CODE"
echo -e "                       ${DIM}Enter this in Spinny → Settings → Local Node${RST}"
[[ -n "$QR_URL" ]] && printf "  %-18s: %s\n" "QR URL" "$QR_URL"
echo ""
printf "  %-18s: " "Dashboard token"
echo -e "${Y}${B}${DASH_TOKEN}${RST}"
echo -e "                       ${DIM}${ENV_FILE}${RST}"
echo ""
printf "  %-18s: %s\n" "Git" "$GIT_STATUS"
echo ""
echo -e "${DIM}--------------------------------------------------------------------${RST}"
echo -e "  Node is ready. Open ${B}spinny.au${RST} and enter your pairing code."
echo -e "${DIM}${LINE}${RST}"
echo ""
