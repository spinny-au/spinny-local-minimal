#!/usr/bin/env bash
# Spinny Local Node — macOS installer
#
# One-liner:
#   bash <(curl -fsSL https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/install-macos.sh)
#
# Fresh install (wipes state, re-pairs):
#   bash <(curl -fsSL .../install-macos.sh) --fresh
#
# Update only (keeps pairing):
#   bash <(curl -fsSL .../install-macos.sh) --update
#
# Headless server (auto-installs + connects Tailscale for remote access):
#   bash <(curl -fsSL .../install-macos.sh) --headless
set -euo pipefail

REPO_URL="https://github.com/spinny-au/spinny-local-minimal.git"
INSTALL_DIR="$HOME/.spinny/node"
STATE_DIR="$HOME/.spinny-local"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/au.spinny.local-node.plist"
SERVICE_LABEL="au.spinny.local-node"
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
if node --version 2>/dev/null | grep -qE '^v2[2-9]'; then
  ok "Node.js $(node --version) already installed"
else
  step "Installing Node.js 22"
  if command -v brew &>/dev/null; then
    brew install node@22 --quiet
    brew link --force --overwrite node@22 2>/dev/null || true
  else
    warn "Homebrew not found — installing Node.js via official installer"
    _pkg=$(mktemp /tmp/node-XXXXXX.pkg)
    curl -fsSL "https://nodejs.org/dist/latest-v22.x/node-v22.0.0.pkg" -o "$_pkg" || \
      { warn "Direct download failed — install Node.js 22 from https://nodejs.org then re-run"; fail "Node.js required"; }
    sudo installer -pkg "$_pkg" -target / >/dev/null
    rm -f "$_pkg"
  fi
  ok "Node.js $(node --version) installed"
fi

# ── 2. Git ────────────────────────────────────────────────────────────────────
step "Checking Git"
if command -v git &>/dev/null; then
  ok "$(git --version)"
else
  warn "Git not found — installing via Xcode Command Line Tools"
  xcode-select --install 2>/dev/null || true
  ok "Git installed"
fi

# ── 3. Ollama ─────────────────────────────────────────────────────────────────
step "Checking Ollama"
OLLAMA_RUNNING=false; OLLAMA_MODELS=()
if command -v ollama &>/dev/null; then
  ok "Ollama already installed"
else
  step "Installing Ollama"
  if command -v brew &>/dev/null; then
    brew install ollama --quiet
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
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
  launchctl unload "$PLIST" 2>/dev/null || true
  pkill -f "spinny-local-minimal/node" 2>/dev/null || true
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
  launchctl unload "$PLIST" 2>/dev/null || true
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
EXISTING_NAME=""
[[ -f "$ENV_FILE" ]] && EXISTING_TOKEN=$(grep -oE 'SPINNY_DASHBOARD_TOKEN=\S+' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
[[ -f "$ENV_FILE" ]] && EXISTING_NAME=$(grep -oE 'SPINNY_NODE_NAME=\S+' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
DASH_TOKEN="${EXISTING_TOKEN:-$(openssl rand -base64 33 | tr -d '/+=\n' | head -c 44)}"
NODE_SLUG=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-20)
NODE_NAME_ENV="${EXISTING_NAME:-spinny-${NODE_SLUG:-node}}"

{
  echo "# Auto-generated by install-macos.sh — do not commit"
  echo "SPINNY_CONTROL_URL=$CONTROL_URL"
  echo "SPINNY_BIND_HOST=0.0.0.0"
  echo "SPINNY_DASHBOARD_TOKEN=${DASH_TOKEN}"
  echo "SPINNY_NODE_NAME=${NODE_NAME_ENV}"
  echo "SPINNY_ALLOW_INSECURE_FILE_KEY=1"
} > "$ENV_FILE"
ok ".env written (node name: ${NODE_NAME_ENV})"

# ── 8. spinny CLI wrapper ─────────────────────────────────────────────────────
step "Installing spinny CLI"
# Prefer /usr/local/bin (always on PATH); fall back to ~/.local/bin.
if [[ "$EUID" -eq 0 ]] || command -v sudo &>/dev/null; then
  CLI_DIR="/usr/local/bin"
else
  CLI_DIR="$HOME/.local/bin"
  mkdir -p "$CLI_DIR"
fi

SPINNY_PLIST="$HOME/Library/LaunchAgents/au.spinny.local-node.plist"
SPINNY_SERVICE_LABEL="au.spinny.local-node"
SPINNY_INSTALL_DIR="$HOME/.spinny/node"
SPINNY_INSTALL_SCRIPT="https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/install-macos.sh"

CLI_WRAPPER="$(mktemp)"
cat > "$CLI_WRAPPER" <<SPINNY_CLI
#!/usr/bin/env bash
PLIST="$SPINNY_PLIST"
SERVICE_LABEL="$SPINNY_SERVICE_LABEL"
INSTALL_DIR="$SPINNY_INSTALL_DIR"
INSTALL_SCRIPT="$SPINNY_INSTALL_SCRIPT"
ENV_FILE="\$INSTALL_DIR/.env"

state_file() {
  local home_dir="\${SPINNY_HOME:-\$HOME/.spinny-local}"
  if [[ -f "\$ENV_FILE" ]]; then
    local env_home
    env_home=\$(grep -E '^SPINNY_HOME=' "\$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"')
    [[ -n "\$env_home" ]] && home_dir="\$env_home"
  fi
  echo "\$home_dir/state.json"
}

print_pairing_code() {
  local file="\$(state_file)"
  if [[ ! -f "\$file" ]]; then
    echo "No pairing code found. State file missing: \$file"
    return 1
  fi
  local code
  code=\$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if (s.pairingCode) console.log(s.pairingCode)}catch{}" "\$file" 2>/dev/null)
  if [[ -z "\$code" ]]; then
    echo "No pairing code found in \$file"
    return 1
  fi
  echo "\$code"
}

gen_pairing_code() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to regenerate a pairing code"
    return 1
  fi
  local token=""
  if [[ -f "\$ENV_FILE" ]]; then
    token=\$(grep -E '^SPINNY_DASHBOARD_TOKEN=' "\$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"')
  fi
  local args=(-sS -X POST)
  [[ -n "\$token" ]] && args+=(-H "Cookie: spinny_dash=\$token")
  local body
  body=\$(curl "\${args[@]}" "http://localhost:47821/pairing/token/regenerate" 2>/dev/null || true)
  local code
  code=\$(printf '%s' "\$body" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d); if (j.code) console.log(j.code)}catch{}})" 2>/dev/null)
  if [[ -z "\$code" ]]; then
    echo "Could not regenerate pairing code. Is the node running?"
    [[ -n "\$body" ]] && echo "\$body"
    return 1
  fi
  echo "\$code"
}

request_pairme2() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to send a pairing request"
    return 1
  fi
  local email="\${1:-}"
  if [[ -z "\$email" || "\$email" != *@* ]]; then
    echo "Usage: spinny pairme2 email@example.com"
    return 1
  fi
  local token=""
  if [[ -f "\$ENV_FILE" ]]; then
    token=\$(grep -E '^SPINNY_DASHBOARD_TOKEN=' "\$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"')
  fi
  local payload
  payload=\$(node -e 'process.stdout.write(JSON.stringify({email:process.argv[1]}))' "\$email")
  local args=(-sS -X POST -H "Content-Type: application/json")
  [[ -n "\$token" ]] && args+=(-H "Cookie: spinny_dash=\$token")
  local body
  body=\$(curl "\${args[@]}" --data "\$payload" "http://localhost:47821/pairing/request" 2>/dev/null || true)
  local parsed
  parsed=\$(printf '%s' "\$body" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d); if(j.requestId) console.log([j.requestId,j.targetEmail||'',j.nodeId||'',j.expiresAt||''].join('\\t')); else if(j.error) console.error(j.error)}catch{}})" 2>/tmp/spinny-pairme2.err)
  if [[ -z "\$parsed" && -f "\$INSTALL_DIR/src/main.js" ]]; then
    body=\$(cd "\$INSTALL_DIR" && node --experimental-sqlite --no-warnings --env-file-if-exists=.env src/main.js pairme2 "\$email" 2>/tmp/spinny-pairme2.err || true)
    parsed=\$(printf '%s' "\$body" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d); if(j.requestId) console.log([j.requestId,j.targetEmail||'',j.nodeId||'',j.expiresAt||''].join('\\t'))}catch{}})" 2>/dev/null)
  fi
  if [[ -z "\$parsed" ]]; then
    echo "Could not send pairing request. Is the node running?"
    if [[ -s /tmp/spinny-pairme2.err ]]; then cat /tmp/spinny-pairme2.err; fi
    [[ -n "\$body" ]] && echo "\$body"
    return 1
  fi
  IFS=\$'\t' read -r request_id target_email node_id expires_at <<< "\$parsed"
  echo "Pairing request sent to \$target_email"
  echo "Request: \$request_id"
  echo "Node: \$node_id"
  [[ -n "\$expires_at" ]] && echo "Expires: \$expires_at"
  echo "Open spinny.au -> Settings -> Local Node -> Pairing Requests, then click Pair."
}

if [[ "\${1:-}" == "pairme2" || "\${1:-}" == "pairme" || "\${1:-}" == "requestpair" ]]; then
  request_pairme2 "\${2:-}"
  exit \$?
fi

CLI_CMD="\${*:-help}"

case "\$CLI_CMD" in
  --update|update)
    echo "Updating Spinny local node..."
    bash <(curl -fsSL "\$INSTALL_SCRIPT") --update ;;
  --fresh|fresh)
    echo "Fresh install (wipes state)..."
    bash <(curl -fsSL "\$INSTALL_SCRIPT") --fresh ;;
  status)
    launchctl list "\$SERVICE_LABEL" ;;
  logs)
    tail -f "\$INSTALL_DIR/spinny-local.log" ;;
  restart)
    launchctl unload "\$PLIST" 2>/dev/null; launchctl load "\$PLIST" && echo "Restarted." ;;
  stop)
    launchctl unload "\$PLIST" 2>/dev/null && echo "Stopped." ;;
  start)
    launchctl load "\$PLIST" && echo "Started." ;;
  version|--version|-v)
    if [[ -f "\$INSTALL_DIR/package.json" ]]; then
      node -e "console.log(require(process.argv[1]).version)" "\$INSTALL_DIR/package.json" 2>/dev/null \
        || grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "\$INSTALL_DIR/package.json" | head -1 | sed -E 's/.*"([^"]+)".*/\1/'
    else
      echo "unknown"
    fi ;;
  pairingcode|pairing-code|"pairing code")
    print_pairing_code ;;
  genpairingcode|gen-pairing-code|"gen pairing code"|"generate pairing code")
    gen_pairing_code ;;
  sendhealth|send-health|"send health")
    (
      cd "\$INSTALL_DIR" &&
      node --experimental-sqlite --no-warnings --env-file-if-exists=.env --input-type=module -e "import('./src/relay.js').then(async m => { const r = await m.pushHealthDirect(); if (r?.skipped) { console.error(r.reason); process.exit(1) } console.log('Health sent to spinny.au') }).catch(err => { console.error(err?.message || String(err)); process.exit(1) })"
    ) ;;
  help|--help|-h|*)
    echo "Usage: spinny <command>"
    echo "  spinny --update   Pull latest code and restart"
    echo "  spinny --fresh    Wipe state and reinstall (re-pairs)"
    echo "  spinny version    Show installed version"
    echo "  spinny pairing code    Show current pairing code"
    echo "  spinny pairme2 email   Request pairing from spinny.au"
    echo "  spinny genpairingcode  Generate a fresh pairing code"
    echo "  spinny sendhealth      Push current health to spinny.au"
    echo "  spinny status     Show service status"
    echo "  spinny logs       Tail the node log"
    echo "  spinny restart    Restart the service"
    echo "  spinny start / stop" ;;
esac
SPINNY_CLI

if [[ "$CLI_DIR" == "/usr/local/bin" && "$EUID" -ne 0 ]]; then
  if ! sudo install -m 755 "$CLI_WRAPPER" "$CLI_DIR/spinny"; then
    CLI_DIR="$HOME/.local/bin"
    mkdir -p "$CLI_DIR"
    install -m 755 "$CLI_WRAPPER" "$CLI_DIR/spinny"
  fi
else
  install -m 755 "$CLI_WRAPPER" "$CLI_DIR/spinny"
fi
rm -f "$CLI_WRAPPER"

# Also ensure ~/.local/bin is on PATH for non-root fallback
if [[ "$CLI_DIR" != "/usr/local/bin" ]]; then
  for RC in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc" "$HOME/.zprofile"; do
    [[ -f "$RC" ]] || continue
    grep -q '.local/bin' "$RC" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$RC"
  done
  export PATH="$HOME/.local/bin:$PATH"
fi
ok "spinny CLI installed at $CLI_DIR/spinny"

# ── 10. launchd service ───────────────────────────────────────────────────────
step "Installing launchd service"
NODE_BIN=$(which node)
mkdir -p "$PLIST_DIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>--experimental-sqlite</string>
    <string>--no-warnings</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/main.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${INSTALL_DIR}/spinny-local.log</string>
  <key>StandardErrorPath</key><string>${INSTALL_DIR}/spinny-local.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
ok "Service started (runs at login)"

# ── 9. Wait for pairing code ──────────────────────────────────────────────────
step "Waiting for node to initialise"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$INSTALL_DIR/spinny-local.log"
PAIRING_CODE=""; PAIRED=false
for i in $(seq 1 90); do
  sleep 1
  if [[ -f "$STATE_FILE" ]]; then
    IS_PAIRED=$(grep -oP '(?<="paired":)true' "$STATE_FILE" 2>/dev/null || true)
    [[ -n "$IS_PAIRED" ]] && PAIRED=true && break
  fi
  if [[ -f "$LOG_FILE" ]]; then
    LAST_AD=$(grep -oP '\[relay-pair\] advertise \K[A-Z0-9]+(?= ->)' "$LOG_FILE" 2>/dev/null | tail -1 || true)
    [[ -n "$LAST_AD" ]] && PAIRING_CODE="$LAST_AD" && break
  fi
  if [[ -f "$STATE_FILE" ]]; then
    CODE=$(grep -oP '(?<="pairingCode":")[^"]+' "$STATE_FILE" 2>/dev/null || true)
    [[ -n "$CODE" ]] && PAIRING_CODE="$CODE"
  fi
done
[[ -z "$PAIRING_CODE" && "$PAIRED" == "false" ]] && PAIRING_CODE="run: launchctl log $SERVICE_LABEL"

# ── 10. Tailscale ─────────────────────────────────────────────────────────────
TAILSCALE_STR="Not installed"
if $HEADLESS; then
  step "Installing Tailscale (headless mode)"
  if ! command -v tailscale &>/dev/null; then
    if command -v brew &>/dev/null; then
      brew install tailscale --quiet
    else
      warn "Homebrew not found — install Tailscale from https://tailscale.com/download/mac then run: tailscale up"
    fi
    ok "Tailscale installed"
  else
    ok "Tailscale already installed"
  fi
  if command -v tailscale &>/dev/null; then
    sudo tailscale up --accept-routes 2>/dev/null || true
    TAILSCALE_IP=$(tailscale ip --4 2>/dev/null || echo '')
    TAILSCALE_STR="${TAILSCALE_IP:+● Connected  •  $TAILSCALE_IP}${TAILSCALE_IP:-○ Installed — run: sudo tailscale up}"
  fi
else
  if command -v tailscale &>/dev/null; then
    TAILSCALE_IP=$(tailscale ip --4 2>/dev/null || echo '')
    TAILSCALE_STR="${TAILSCALE_IP:+● Connected  •  $TAILSCALE_IP}${TAILSCALE_IP:-○ Installed (not connected)}"
  fi
fi

# ── 11. System info ───────────────────────────────────────────────────────────
CPU_COUNT=$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo '?')
RAM_GB=$(awk "BEGIN {printf \"%.1f GB\", $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824}")
DISK_FREE=$(df -h "$INSTALL_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo '?')
GPU_INFO=$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}' || echo 'No GPU info')
NODE_VER=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo '?')
SVC_OK=$(launchctl list "$SERVICE_LABEL" &>/dev/null && echo true || echo false)
STATUS_STR=$( $SVC_OK && echo "● Running" || echo "○ Not running — run: launchctl load $PLIST")
OLLAMA_STR=$($OLLAMA_RUNNING && echo "● Running  •  ${#OLLAMA_MODELS[@]} model(s)" || echo "○ Not running")
BRAIN="${OLLAMA_MODELS[0]:-no model installed yet}"
GIT_STR="✓ $(git --version)  (updates: spinny --update)"

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
printf "  %-18s: %s\n"                                   "Node name" "$NODE_NAME_ENV"
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

if ! $PAIRED && [[ -n "$PAIRING_CODE" ]]; then
  echo ""
  echo -e "${Y}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
  echo -e "${Y}${B}  PAIR THIS NODE AT SPINNY.AU  →  CODE: ${PAIRING_CODE}${RST}"
  echo -e "${Y}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
  echo ""
fi
