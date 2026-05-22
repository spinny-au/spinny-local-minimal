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
# Headless server — installs Tailscale, waits for browser auth, sets up HTTPS proxy:
#   bash <(curl -fsSL .../install-linux.sh) --headless
#
# Headless + pre-auth key (fully automated, no browser interaction):
#   bash <(curl -fsSL .../install-linux.sh) --headless --ts-authkey=tskey-auth-xxxxx
#   Get a key at: https://login.tailscale.com/admin/settings/keys
set -euo pipefail

REPO_URL="https://github.com/spinny-au/spinny-local-minimal.git"
INSTALL_DIR="$HOME/.local/share/spinny-local-minimal"
STATE_DIR="$HOME/.spinny-local"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/spinny-local-minimal.service"
SERVICE_NAME="spinny-local-minimal"
NODE_PORT=47821
CONTROL_URL="https://spinny.au"

FRESH=false; UPDATE=false; HEADLESS=false; TS_AUTHKEY=""
for arg in "$@"; do
  [[ "$arg" == "--fresh"    ]] && FRESH=true
  [[ "$arg" == "--update"   ]] && UPDATE=true
  [[ "$arg" == "--headless" ]] && HEADLESS=true
  [[ "$arg" == --ts-authkey=* ]] && TS_AUTHKEY="${arg#--ts-authkey=}"
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
  rm -f "$SERVICE_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
  pkill -f "spinny-local-minimal" 2>/dev/null || true
  rm -rf "$INSTALL_DIR" "$STATE_DIR"
  rm -f "$HOME/.local/bin/spinny"
  if [[ "$EUID" -eq 0 ]]; then
    rm -f /usr/local/bin/spinny
  elif command -v sudo &>/dev/null; then
    sudo rm -f /usr/local/bin/spinny 2>/dev/null || true
  fi
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
EXISTING_NAME=""
[[ -f "$ENV_FILE" ]] && EXISTING_TOKEN=$(grep -oE 'SPINNY_DASHBOARD_TOKEN=\S+' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
[[ -f "$ENV_FILE" ]] && EXISTING_NAME=$(grep -oE 'SPINNY_NODE_NAME=\S+' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
DASH_TOKEN="${EXISTING_TOKEN:-$(openssl rand -base64 33 | tr -d '/+=\n' | head -c 44)}"
# Node name: spinny-<hostname-slug>. Kept across reinstalls.
NODE_SLUG=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-20)
NODE_NAME_ENV="${EXISTING_NAME:-spinny-${NODE_SLUG:-node}}"

{
  echo "# Auto-generated by install-linux.sh — do not commit"
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

SPINNY_INSTALL_DIR="$HOME/.local/share/spinny-local-minimal"
SPINNY_SERVICE="spinny-local-minimal"
SPINNY_INSTALL_SCRIPT="https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/install-linux.sh"

CLI_WRAPPER="$(mktemp)"
cat > "$CLI_WRAPPER" <<SPINNY_CLI
#!/usr/bin/env bash
SERVICE="$SPINNY_SERVICE"
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

print_version() {
  local package_version="unknown"
  local git_sha="unknown"
  local git_branch="unknown"
  local git_remote="unknown"
  local resolved="not-on-path"
  local node_version="unknown"
  [[ -f "\$INSTALL_DIR/package.json" ]] && package_version=\$(node -e "console.log(require(process.argv[1]).version)" "\$INSTALL_DIR/package.json" 2>/dev/null || echo "unknown")
  [[ -d "\$INSTALL_DIR/.git" ]] && git_sha=\$(git -C "\$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
  [[ -d "\$INSTALL_DIR/.git" ]] && git_branch=\$(git -C "\$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  [[ -d "\$INSTALL_DIR/.git" ]] && git_remote=\$(git -C "\$INSTALL_DIR" remote get-url origin 2>/dev/null || echo "unknown")
  resolved=\$(command -v spinny 2>/dev/null || echo "not-on-path")
  node_version=\$(node --version 2>/dev/null || echo "unknown")
  echo "Spinny local node"
  echo "  package:     \$package_version"
  echo "  git sha:     \$git_sha"
  echo "  git branch:  \$git_branch"
  echo "  git remote:  \$git_remote"
  echo "  node:        \$node_version"
  echo "  install dir: \$INSTALL_DIR"
  echo "  state file:  \$(state_file)"
  echo "  wrapper:     \$0"
  echo "  resolved:    \$resolved"
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
  parsed=\$(printf '%s' "\$body" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d); if(j.alreadyPaired) console.log(['ALREADY',j.targetEmail||'',j.nodeId||''].join('\\t')); else if(j.requestId) console.log([j.requestId,j.targetEmail||'',j.nodeId||'',j.expiresAt||''].join('\\t')); else if(j.error) console.error(j.error)}catch{}})" 2>/tmp/spinny-pairme2.err)
  if [[ -z "\$parsed" && -f "\$INSTALL_DIR/src/main.js" ]]; then
    body=\$(cd "\$INSTALL_DIR" && node --experimental-sqlite --no-warnings --env-file-if-exists=.env src/main.js pairme2 "\$email" 2>/tmp/spinny-pairme2.err || true)
    parsed=\$(printf '%s' "\$body" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d); if(j.alreadyPaired) console.log(['ALREADY',j.targetEmail||'',j.nodeId||''].join('\\t')); else if(j.requestId) console.log([j.requestId,j.targetEmail||'',j.nodeId||'',j.expiresAt||''].join('\\t'))}catch{}})" 2>/dev/null)
  fi
  if [[ -z "\$parsed" ]]; then
    echo "Could not send pairing request. Is the node running?"
    if [[ -s /tmp/spinny-pairme2.err ]]; then cat /tmp/spinny-pairme2.err; fi
    [[ -n "\$body" ]] && echo "\$body"
    return 1
  fi
  IFS=\$'\t' read -r request_id target_email node_id expires_at <<< "\$parsed"
  if [[ "\$request_id" == "ALREADY" ]]; then
    echo "Node is already paired to \$target_email"
    echo "Node: \$node_id"
    return 0
  fi
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
    systemctl --user status "\$SERVICE" --no-pager ;;
  logs)
    tail -f "\$INSTALL_DIR/spinny-local.log" ;;
  restart)
    systemctl --user restart "\$SERVICE" && echo "Restarted." ;;
  stop)
    systemctl --user stop "\$SERVICE" && echo "Stopped." ;;
  start)
    systemctl --user start "\$SERVICE" && echo "Started." ;;
  version|--version|-v)
    print_version ;;
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

# Remove old duplicate wrappers that can shadow the freshly installed one.
if [[ "$CLI_DIR" == "/usr/local/bin" ]]; then
  rm -f "$HOME/.local/bin/spinny" 2>/dev/null || true
fi

# Also ensure ~/.local/bin is on PATH for non-root fallback
if [[ "$CLI_DIR" != "/usr/local/bin" ]]; then
  for RC in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.zshrc"; do
    [[ -f "$RC" ]] || continue
    grep -q '.local/bin' "$RC" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$RC"
  done
  export PATH="$HOME/.local/bin:$PATH"
fi
ok "spinny CLI installed at $CLI_DIR/spinny"

# ── 9. systemd user service ───────────────────────────────────────────────────
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
LOG_FILE="$INSTALL_DIR/spinny-local.log"
PAIRING_CODE=""; PAIRED=false
for i in $(seq 1 90); do
  sleep 1
  # Check if already paired
  if [[ -f "$STATE_FILE" ]]; then
    IS_PAIRED=$(grep -oP '(?<="paired":)true' "$STATE_FILE" 2>/dev/null || true)
    [[ -n "$IS_PAIRED" ]] && PAIRED=true && break
  fi
  # Read code from log (most reliable — shows what node is actively advertising)
  if [[ -f "$LOG_FILE" ]]; then
    LAST_AD=$(grep -oP '\[relay-pair\] advertise \K[A-Z0-9]+(?= ->)' "$LOG_FILE" 2>/dev/null | tail -1 || true)
    [[ -n "$LAST_AD" ]] && PAIRING_CODE="$LAST_AD" && break
  fi
  # Fallback: keep state.json as a candidate, but keep waiting for the active log advertisement.
  if [[ -f "$STATE_FILE" ]]; then
    CODE=$(grep -oP '(?<="pairingCode":")[^"]+' "$STATE_FILE" 2>/dev/null || true)
    [[ -n "$CODE" ]] && PAIRING_CODE="$CODE"
  fi
done
[[ -z "$PAIRING_CODE" && "$PAIRED" == "false" ]] && PAIRING_CODE="check: cat $STATE_FILE | python3 -m json.tool | grep pairingCode"

# ── 10. Tailscale ─────────────────────────────────────────────────────────────
TAILSCALE_STR="Not installed"
SPINNY_SERVE_URL=""
if $HEADLESS; then
  # ── Install Tailscale ────────────────────────────────────────────────────────
  step "Installing Tailscale"
  if ! command -v tailscale &>/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
    ok "Tailscale installed"
  else
    ok "Tailscale already installed"
  fi

  # ── Authenticate Tailscale ───────────────────────────────────────────────────
  TAILSCALE_IP=$(tailscale ip --4 2>/dev/null | head -n1 || echo '')
  if [[ -z "$TAILSCALE_IP" ]]; then
    if [[ -n "$TS_AUTHKEY" ]]; then
      # Pre-auth key supplied — silent, non-interactive
      step "Connecting Tailscale (pre-auth key)"
      sudo tailscale up --authkey="$TS_AUTHKEY" --accept-routes 2>/dev/null || true
    else
      # Interactive: print the auth URL and wait for the user to open it
      step "Connecting Tailscale — open the URL below in your browser"
      echo ""
      echo -e "  ${Y}${B}Waiting for Tailscale authentication...${RST}"
      echo -e "  ${DIM}(or re-run with --ts-authkey=<key> for fully automated install)${RST}"
      echo ""
      # tailscale up prints the URL then blocks — run it in background, grep URL
      sudo tailscale up --accept-routes 2>&1 | tee /tmp/ts-up.log &
      TS_PID=$!
      # Print the auth URL as soon as it appears
      for i in $(seq 1 15); do
        sleep 1
        TS_URL=$(grep -oE 'https://login\.tailscale\.com/[^ ]+' /tmp/ts-up.log 2>/dev/null | head -1 || true)
        [[ -n "$TS_URL" ]] && echo -e "\n  ${C}${B}▶ Open in your browser: ${TS_URL}${RST}\n" && break
      done
      # Wait up to 3 minutes for auth to complete
      echo -e "  ${DIM}Waiting up to 3 minutes for authentication...${RST}"
      for i in $(seq 1 180); do
        sleep 1
        TAILSCALE_IP=$(tailscale ip --4 2>/dev/null | head -n1 || echo '')
        [[ -n "$TAILSCALE_IP" ]] && break
      done
      kill "$TS_PID" 2>/dev/null || true
      rm -f /tmp/ts-up.log
    fi
    TAILSCALE_IP=$(tailscale ip --4 2>/dev/null | head -n1 || echo '')
  fi

  if [[ -n "$TAILSCALE_IP" ]]; then
    ok "Tailscale connected: $TAILSCALE_IP"

    # ── tailscale serve: HTTPS proxy so browsers can reach the node ──────────
    # spinny.au is served over HTTPS; browsers block http:// private IPs.
    # tailscale serve fronts the node with a valid TLS cert at :<NODE_PORT>.
    step "Setting up tailscale serve (HTTPS proxy)"
    TS_HOSTNAME=$(tailscale status --json 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Self',{}).get('DNSName','').rstrip('.'))" \
      2>/dev/null || true)

    if [[ -n "$TS_HOSTNAME" ]]; then
      sudo tailscale serve --bg --https="${NODE_PORT}" "http://localhost:${NODE_PORT}" 2>/dev/null \
        || tailscale serve --bg --https="${NODE_PORT}" "http://localhost:${NODE_PORT}" 2>/dev/null \
        || warn "tailscale serve failed — run manually: sudo tailscale serve --bg --https=${NODE_PORT} http://localhost:${NODE_PORT}"
      SPINNY_SERVE_URL="https://${TS_HOSTNAME}:${NODE_PORT}"
      grep -v '^SPINNY_SERVE_URL=' "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
      echo "SPINNY_SERVE_URL=${SPINNY_SERVE_URL}" >> "$ENV_FILE"
      # Restart node so it picks up the new SPINNY_SERVE_URL
      systemctl --user restart "$SERVICE_NAME" 2>/dev/null || true
      ok "HTTPS proxy ready: ${SPINNY_SERVE_URL}"
      TAILSCALE_STR="● Connected  •  ${TAILSCALE_IP}  •  ${SPINNY_SERVE_URL}"
    else
      warn "Could not read Tailscale hostname — skipping tailscale serve"
      TAILSCALE_STR="● Connected  •  ${TAILSCALE_IP}"
    fi
  else
    warn "Tailscale not authenticated — run: sudo tailscale up"
    warn "Then run: sudo tailscale serve --bg --https=${NODE_PORT} http://localhost:${NODE_PORT}"
    TAILSCALE_STR="○ Not connected — run: sudo tailscale up"
  fi
else
  if command -v tailscale &>/dev/null; then
    TAILSCALE_IP=$(tailscale ip --4 2>/dev/null | head -n1 || echo '')
    TAILSCALE_STR="${TAILSCALE_IP:+● Connected  •  $TAILSCALE_IP}${TAILSCALE_IP:-○ Installed (not connected)}"
  fi
fi

# ── 11. System info ───────────────────────────────────────────────────────────
CPU_COUNT=$(nproc 2>/dev/null || echo '?')
RAM_GB=$(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null || echo '?')
DISK_FREE=$(df -h "$INSTALL_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo '?')
GPU_INFO=$(lspci 2>/dev/null | grep -i 'vga\|3d\|display' | head -1 | sed 's/.*: //' || echo 'No GPU info')
NODE_VER=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || echo '?')
GIT_SHA=$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')
SVC_OK=$(systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null && echo true || echo false)
STATUS_STR=$( $SVC_OK && echo "● Running" || echo "○ Not running — run: systemctl --user start ${SERVICE_NAME}")
OLLAMA_STR=$($OLLAMA_RUNNING && echo "● Running  •  ${#OLLAMA_MODELS[@]} model(s)" || echo "○ Not running")
BRAIN="${OLLAMA_MODELS[0]:-no model installed yet}"
GIT_STR="OK $(git --version)  -  commit ${GIT_SHA}  (updates: spinny --update)"

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
echo -e "  ${B}SPINNY LOCAL NODE  v${NODE_VER} (${GIT_SHA})  SUCCESSFULLY INSTALLED${RST}"
echo -e "${DIM}--------------------------------------------------------------------${RST}"
echo ""
printf "  %-18s: %s\n"                                   "Node name" "$NODE_NAME_ENV"
printf "  %-18s: %s vCPUs  •  %s  •  %s  •  %s free\n" "Hardware"  "$CPU_COUNT" "$RAM_GB" "$GPU_INFO" "$DISK_FREE"
printf "  %-18s: %s\n"                                   "Ollama"    "$OLLAMA_STR"
printf "  %-18s: %s\n"                                   "Brain"     "$BRAIN"
printf "  %-18s: %s\n"                                   "Status"    "$STATUS_STR"
[[ "$TAILSCALE_STR" != "Not installed" ]] && printf "  %-18s: %s\n" "Tailscale" "$TAILSCALE_STR"
[[ -n "$SPINNY_SERVE_URL"              ]] && printf "  %-18s: %s\n" "Remote URL" "$SPINNY_SERVE_URL"
echo ""
printf "  %-18s: http://localhost:%s\n" "Node UI" "$NODE_PORT"
echo ""
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

if $PAIRED; then
  echo -e "  ${G}${B}✓ Already paired. Open spinny.au to start using Spinny.${RST}"
  echo -e "${DIM}${LINE}${RST}"
  echo ""
else
  echo -e "  Node is ready. ${B}Enter your spinny.au email to pair this node:${RST}"
  echo -e "${DIM}${LINE}${RST}"
  echo ""

  PAIR_EMAIL=""
  PAIR_SUCCESS=false

  if [[ -t 0 ]]; then
    read -rp "  Email: " PAIR_EMAIL
    PAIR_EMAIL=$(echo "$PAIR_EMAIL" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  fi

  if [[ -z "$PAIR_EMAIL" || "$PAIR_EMAIL" != *@* ]]; then
    warn "No email entered — pair later with: spinny pairme2 <email>"
    echo -e "  ${DIM}Backup: enter code ${B}${PAIRING_CODE}${RST}${DIM} at spinny.au → Settings → Local Node${RST}"
    echo ""
  else
    echo ""
    echo -e "  ${C}Sending pairing request to ${B}${PAIR_EMAIL}${RST}${C}...${RST}"
    echo ""

    cd "$INSTALL_DIR"
    "$NODE_BIN" --experimental-sqlite --no-warnings --env-file-if-exists=.env \
      src/main.js pairme2 "$PAIR_EMAIL" >/tmp/spinny-pairme2.log 2>&1 &
    PAIRME2_PID=$!

    printf "  ${Y}Waiting for approval on spinny.au${RST}"
    for i in $(seq 1 180); do
      sleep 1
      if ! kill -0 "$PAIRME2_PID" 2>/dev/null; then
        break
      fi
      if [[ -f "$STATE_FILE" ]]; then
        IS_PAIRED=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print('yes' if d.get('paired') else '')" 2>/dev/null || true)
        [[ "$IS_PAIRED" == "yes" ]] && PAIR_SUCCESS=true && break
      fi
      [[ $((i % 2)) -eq 0 ]] && printf "."
    done

    kill "$PAIRME2_PID" 2>/dev/null || true
    wait "$PAIRME2_PID" 2>/dev/null || true
    echo ""
    echo ""

    if $PAIR_SUCCESS; then
      PAIRED_AS=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('accountId',''))" 2>/dev/null || echo "$PAIR_EMAIL")
      echo -e "${DIM}${LINE}${RST}"
      echo -e "  ${G}${B}✓ Node paired as ${PAIRED_AS}${RST}"
      echo -e "${DIM}${LINE}${RST}"
      echo ""
      echo -e "  ${B}Your node is live at spinny.au${RST}"
      echo ""
      echo -e "  ${DIM}Pair again later  : ${B}spinny pairme2 ${PAIR_EMAIL}${RST}"
      echo -e "  ${DIM}Get pairing code  : ${B}spinny pairingcode${RST}"
      echo ""
    else
      echo -e "${DIM}${LINE}${RST}"
      echo -e "  ${Y}${B}⚠  Approval pending — open spinny.au to approve${RST}"
      echo -e "${DIM}${LINE}${RST}"
      echo ""
      if [[ -s /tmp/spinny-pairme2.log ]] && grep -qiE "Pairing request failed|Error|failed" /tmp/spinny-pairme2.log; then
        echo -e "  ${R}${B}Pairing request failed before it reached spinny.au:${RST}"
        sed -n '1,12p' /tmp/spinny-pairme2.log
        echo ""
      fi
      echo -e "  The request was sent to ${B}${PAIR_EMAIL}${RST}."
      echo -e "  Open ${B}spinny.au${RST}, go to Settings → Local Node and approve it."
      echo ""
      echo -e "  ${DIM}Backup code: ${B}${PAIRING_CODE}${RST}${DIM} (spinny.au → Settings → Local Node → Connect)${RST}"
      echo -e "  ${DIM}Once approved the node goes online automatically.${RST}"
      echo ""
    fi
  fi
fi
