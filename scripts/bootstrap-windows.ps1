#Requires -Version 5.1
# Spinny Local Node — Windows installer
#
# Fresh install / re-pair:
#   & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/bootstrap-windows.ps1'))) --fresh
#
# Update only (keeps pairing):
#   & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/bootstrap-windows.ps1'))) --update

$isFresh  = $args -contains '--fresh'  -or $args -contains '-fresh'
$isUpdate = $args -contains '--update' -or $args -contains '-update'

$ErrorActionPreference = 'Stop'

$REPO_URL    = 'https://github.com/spinny-au/spinny-local-minimal.git'
$INSTALL_DIR = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
$STATE_DIR   = "$env:USERPROFILE\.spinny-local"
$STATE_FILE  = "$STATE_DIR\state.json"
$NODE_PORT   = 47821
$CONTROL_URL = 'https://spinny.au'
$TASK_NAME   = 'SpinnyLocalNode'

# ── ANSI colours (Windows 10 1511+) ──────────────────────────────────────────
$e = [char]27
$R   = "$e[0;31m";  $G   = "$e[0;32m";  $Y  = "$e[1;33m"
$C   = "$e[0;36m";  $B   = "$e[1m";     $DIM = "$e[2m";  $RST = "$e[0m"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function step($m) { Write-Host "`n${C}${B}▶ $m${RST}" }
function ok($m)   { Write-Host "${G}✓ $m${RST}" }
function warn($m) { Write-Host "${Y}⚠ $m${RST}" }
function fail($m) { Write-Host "${R}✗ $m${RST}"; exit 1 }

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
}

function Stop-Node {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
        Where-Object { $_.CommandLine -like "*SpinnyLocalMinimal*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
}

# ── 1. Node.js 22 ─────────────────────────────────────────────────────────────
step 'Checking Node.js'
$nodeVer = node --version 2>$null
$nodeMaj = if ($nodeVer) { [int]($nodeVer -replace 'v(\d+).*','$1') } else { 0 }
if ($nodeMaj -ge 22) {
    ok "Node.js $nodeVer already installed"
} else {
    warn 'Installing Node.js 22 via winget…'
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements -h | Out-Null
    Refresh-Path
    ok "Node.js $(node --version) installed"
}

# ── 2. Git ────────────────────────────────────────────────────────────────────
step 'Checking Git'
if (Get-Command git -EA SilentlyContinue) {
    ok "$(git --version)"
} else {
    warn 'Installing Git via winget…'
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements -h | Out-Null
    Refresh-Path
    ok "$(git --version)"
}

# ── 3. Ollama ─────────────────────────────────────────────────────────────────
step 'Checking Ollama'
$ollamaRunning = $false; $ollamaModels = @()
if (Get-Command ollama -EA SilentlyContinue) {
    ok 'Ollama already installed'
} else {
    warn 'Installing Ollama via winget…'
    winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements -h | Out-Null
    Refresh-Path
    ok 'Ollama installed'
}
try {
    $list = ollama list 2>$null
    if ($list) {
        $ollamaRunning = $true
        $ollamaModels  = $list -split "`n" | Select-Object -Skip 1 |
                         Where-Object { $_ -match '\S' } |
                         ForEach-Object { ($_ -split '\s+')[0] }
    }
} catch {}

# ── 4. Fresh / Update ─────────────────────────────────────────────────────────
if ($isFresh) {
    step 'Fresh install — wiping previous installation'
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -EA SilentlyContinue
    Stop-Node
    Start-Sleep 1
    if (Test-Path $INSTALL_DIR) { & cmd /c "rmdir /s /q `"$INSTALL_DIR`"" }
    if (Test-Path $STATE_FILE)  { Remove-Item -Force $STATE_FILE }
    ok 'Wiped'
}

if ($isUpdate -and -not (Test-Path "$INSTALL_DIR\.git")) {
    fail "No existing install at $INSTALL_DIR — run without --update to install first"
}

# ── 5. Kill any old node process on port 47821 ────────────────────────────────
step 'Stopping any running Spinny processes'
Stop-Node
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -like "*tray-windows.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
# Also kill anything holding port 47821
$portPid = (netstat -ano 2>$null | Select-String ":47821\s") -replace '.*\s(\d+)$','$1' | Select-Object -First 1
if ($portPid -and $portPid -match '^\d+$') {
    Stop-Process -Id ([int]$portPid) -Force -EA SilentlyContinue
    Start-Sleep 1
}
ok 'Old processes stopped'

# ── 6. Clone / pull ───────────────────────────────────────────────────────────
step 'Setting up Spinny Local Node'
if (Test-Path "$INSTALL_DIR\.git") {
    git -C $INSTALL_DIR pull --ff-only
    if ($LASTEXITCODE -ne 0) { fail "git pull failed — run with --fresh to do a clean install" }
    ok 'Updated to latest'
} else {
    # Wipe any partial/broken install before cloning
    if (Test-Path $INSTALL_DIR) {
        warn "Install directory exists but has no .git — wiping partial install"
        & cmd /c "rmdir /s /q `"$INSTALL_DIR`"" 2>$null
        Start-Sleep 1
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $INSTALL_DIR) | Out-Null
    git clone $REPO_URL $INSTALL_DIR
    if ($LASTEXITCODE -ne 0) { fail "git clone failed — check your internet connection and try again" }
    ok 'Cloned'
}

# Verify critical files are present before continuing
if (-not (Test-Path "$INSTALL_DIR\src\main.js")) {
    fail "Clone appears incomplete — src/main.js missing. Run the installer again."
}
if (-not (Test-Path "$INSTALL_DIR\ui\dist\index.html")) {
    fail "Clone appears incomplete — ui/dist/index.html missing. Run the installer again."
}

# ── 7. Dependencies ───────────────────────────────────────────────────────────
step 'Installing npm dependencies'
npm install --prefix $INSTALL_DIR --omit=dev --silent
if ($LASTEXITCODE -ne 0) { fail "npm install failed" }
ok 'Dependencies ready'

# ── 8. .env ───────────────────────────────────────────────────────────────────
step 'Writing .env'
$envFile   = "$INSTALL_DIR\.env"
$dashToken = ''
if (Test-Path $envFile) {
    $dashToken = (Get-Content $envFile |
        Select-String 'SPINNY_DASHBOARD_TOKEN=(.+)' |
        ForEach-Object { $_.Matches[0].Groups[1].Value } |
        Select-Object -First 1)
}
if (-not $dashToken) {
    $chars     = (48..57) + (65..90)  # 0-9 A-Z
    $dashToken = -join ($chars | Get-Random -Count 44 | ForEach-Object { [char]$_ })
}

$envContent = @"
# Auto-generated by bootstrap-windows.ps1 — do not commit
SPINNY_CONTROL_URL=$CONTROL_URL
SPINNY_BIND_HOST=0.0.0.0
SPINNY_DASHBOARD_TOKEN=$dashToken
SPINNY_ALLOW_INSECURE_FILE_KEY=1
"@
[System.IO.File]::WriteAllText($envFile, $envContent, [System.Text.UTF8Encoding]::new($false))
ok '.env written'

# ── 8. Desktop shortcut ───────────────────────────────────────────────────────
$shortcutPath = "$env:USERPROFILE\Desktop\Spinny Local.url"
"[InternetShortcut]`r`nURL=http://localhost:$NODE_PORT`r`n" |
    Out-File -Encoding ascii $shortcutPath -EA SilentlyContinue
ok 'Desktop shortcut → http://localhost:47821'

# ── 9. Task Scheduler (auto-start, hidden, restarts on failure) ───────────────
step 'Registering auto-start (Task Scheduler)'
$nodeBin = (Get-Command node).Source
$logPath = "$INSTALL_DIR\spinny-local.log"

# Write a dedicated launcher script — avoids quoting/redirection issues in Task Scheduler
$launcherPath = "$INSTALL_DIR\start-node.ps1"
$launcherContent = @"
`$ErrorActionPreference = 'Continue'
Set-Location '$INSTALL_DIR'
Add-Content -Path '$logPath' -Value "[`$(Get-Date -f 'yyyy-MM-dd HH:mm:ss')] SpinnyLocalNode starting (node: `$(& '$nodeBin' --version 2>&1))"
try {
    & '$nodeBin' --experimental-sqlite --no-warnings --env-file-if-exists=.env src/main.js start 2>&1 |
        ForEach-Object { Add-Content -Path '$logPath' -Value "[`$(Get-Date -f 'HH:mm:ss')] `$_" }
} catch {
    Add-Content -Path '$logPath' -Value "[`$(Get-Date -f 'HH:mm:ss')] FATAL: `$_"
}
"@
[System.IO.File]::WriteAllText($launcherPath, $launcherContent, [System.Text.UTF8Encoding]::new($false))

$action  = New-ScheduledTaskAction `
    -Execute     'powershell.exe' `
    -Argument    "-ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -NoProfile -File `"$launcherPath`"" `
    -WorkingDirectory $INSTALL_DIR
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -EA SilentlyContinue
$taskRegistered = $false
try {
    Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force -EA Stop | Out-Null
    $taskRegistered = $true
    ok "Task '$TASK_NAME' registered — starts automatically at login"
} catch {
    warn "Task Scheduler registration failed (run as Admin for auto-start). Starting node directly instead."
}

# ── 10. Start now ─────────────────────────────────────────────────────────────
# Clear log so boot log in the banner reflects this run only
'' | Set-Content $logPath -Encoding UTF8 -EA SilentlyContinue

step 'Starting node'
if ($taskRegistered) {
    try {
        Start-ScheduledTask -TaskName $TASK_NAME -EA Stop
        ok 'Node started via Task Scheduler'
    } catch {
        warn 'Task start failed — launching directly'
        Start-Process 'powershell.exe' -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -NoProfile -File `"$launcherPath`"" -WorkingDirectory $INSTALL_DIR
        ok 'Node started in background'
    }
} else {
    Start-Process 'powershell.exe' -ArgumentList "-WindowStyle Hidden -NonInteractive -NoProfile -File `"$launcherPath`"" -WorkingDirectory $INSTALL_DIR
    ok 'Node started in background (no auto-start — re-run as Admin for that)'
}

# ── 11. Wait for pairing code ─────────────────────────────────────────────────
step 'Waiting for node to initialise'
$pairingCode = ''; $paired = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 1
    if (Test-Path $STATE_FILE) {
        try {
            $st = Get-Content $STATE_FILE -Raw | ConvertFrom-Json
            if ($st.paired -eq $true)  { $paired      = $true;            break }
            if ($st.pairingCode)       { $pairingCode = $st.pairingCode;   break }
        } catch {}
    }
}
if (-not $pairingCode -and -not $paired) {
    $pairingCode = 'check Task Scheduler → SpinnyLocalNode for logs'
}

# ── 12. System info ───────────────────────────────────────────────────────────
$cpu      = (Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum
$ramGB    = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$drive    = (Split-Path $INSTALL_DIR -Qualifier).TrimEnd(':')
$diskFree = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
$gpu      = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
try { $ng = nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1; if ($ng) { $gpu = $ng } } catch {}
$pkgVer   = try { node -p "require('$($INSTALL_DIR.Replace('\','/'))/package.json').version" 2>$null } catch { '?' }
$svcState = (Get-ScheduledTask -TaskName $TASK_NAME -EA SilentlyContinue).State
$svcOk    = $svcState -eq 'Running'
$statusStr   = if ($svcOk) { '● Running' } else { '○ Starting… check Task Scheduler in a moment' }
$ollamaStr   = if ($ollamaRunning) { "● Running  •  $($ollamaModels.Count) model(s)" } else { '○ Not running — launch Ollama and pull a model' }
$brain       = if ($ollamaModels.Count -gt 0) { $ollamaModels[0] } else { 'no model installed yet' }
$gitStr      = "✓ $(git --version)  (updates: re-run bootstrap-windows.ps1)"

$portOk = $false
Start-Sleep 2  # give node a moment
try { Invoke-WebRequest "http://localhost:$NODE_PORT/health" -UseBasicParsing -TimeoutSec 3 | Out-Null; $portOk = $true } catch {}

# ── 13. Banner ────────────────────────────────────────────────────────────────
Clear-Host
$LOGO = @(
    '    /$$$$$$  /$$$$$$$  /$$$$$$ /$$   /$$ /$$   /$$ /$$     /$$',
    '   /$$__  $$| $$__  $$|_  $$_/| $$$ | $$| $$$ | $$|  $$   $$/ ',
    '  | $$  \__/| $$  \ $$  | $$  | $$$$| $$| $$$$| $$ \  $$ /$$/ ',
    '  |  $$$$$$ | $$$$$$$/  | $$  | $$ $$ $$| $$ $$ $$  \  $$$$/ ',
    '   \____  $$| $$____/   | $$  | $$  $$$$| $$  $$$$   \  $$/ ',
    '   /$$  \ $$| $$        | $$  | $$\  $$$| $$\  $$$    | $$   ',
    '  |  $$$$$$/| $$       /$$$$$$| $$ \  $$| $$ \  $$    | $$   ',
    '   \______/ |__/      |______/|__/  \__/|__/  \__/    |__/  '
)
$COLS = @("$e[1;31m","$e[1;33m","$e[1;32m","$e[1;36m","$e[1;34m","$e[1;35m")
$LINE = '=' * 68

Write-Host ''
Write-Host "${Y}${B}  ↓  ↓  ↓  ↓  ↓  ↓  ↓   IMPORTANT — COPY & STORE   ↓  ↓  ↓  ↓  ↓  ↓  ↓${RST}"
Write-Host "${DIM}$LINE${RST}"
for ($i = 0; $i -lt $LOGO.Length; $i++) { Write-Host "$($COLS[$i % 6])$($LOGO[$i])${RST}" }
Write-Host "${DIM}$LINE${RST}"
Write-Host "  🚀  ${B}SPINNY LOCAL NODE  v$pkgVer  SUCCESSFULLY INSTALLED${RST}  🚀"
Write-Host "${DIM}$('-'*68)${RST}"
Write-Host ''
Write-Host ('  {0,-18}: {1} vCPUs  •  {2} GB RAM  •  {3}  •  {4} GB free' -f 'Hardware', $cpu, $ramGB, $gpu, $diskFree)
Write-Host ('  {0,-18}: {1}' -f 'Ollama', $ollamaStr)
Write-Host ('  {0,-18}: {1}' -f 'Brain', $brain)
Write-Host ('  {0,-18}: {1}' -f 'Status', $statusStr)
Write-Host ''
Write-Host ('  {0,-18}: http://localhost:{1}' -f 'Node UI', $NODE_PORT)
Write-Host ''

if ($paired) {
    Write-Host ('  {0,-18}: already paired ✓' -f 'Pairing')
} else {
    Write-Host ('  {0,-18}: {1}' -f 'Pairing code', $pairingCode)
    Write-Host "                       ${DIM}Enter this at spinny.au → Settings → Local Node${RST}"
}

Write-Host ''
Write-Host -NoNewline ('  {0,-18}: ' -f 'Dashboard token')
Write-Host "${Y}${B}$dashToken${RST}"
Write-Host "                       ${DIM}$envFile${RST}"
Write-Host ''
Write-Host ('  {0,-18}: {1}' -f 'Git', $gitStr)
Write-Host ''
Write-Host "${DIM}$('-'*68)${RST}"

if ($portOk) {
    Write-Host "  ${G}${B}✓ Port $NODE_PORT reachable on localhost${RST}"
} else {
    Write-Host "  ${Y}○ Port $NODE_PORT not yet reachable — node is still starting${RST}"

    $logFile = "$INSTALL_DIR\spinny-local.log"
    if (Test-Path $logFile) {
        Write-Host ''
        Write-Host "  ${Y}${B}Boot log (last 30 lines):${RST}"
        Write-Host "${DIM}$('-'*68)${RST}"
        Get-Content $logFile -Tail 30 | ForEach-Object { Write-Host "  $_" }
        Write-Host "${DIM}$('-'*68)${RST}"
    } else {
        Write-Host "  ${DIM}(no log file yet — Task Scheduler may not have fired)${RST}"
    }
}

Write-Host "${DIM}$LINE${RST}"
if ($portOk) {
    Write-Host "  Node is ready. Open ${B}spinny.au${RST} and enter your pairing code."
} else {
    Write-Host "  ${Y}If the log shows an error, fix it then re-run this installer.${RST}"
    Write-Host "  ${DIM}Or check Task Scheduler → SpinnyLocalNode → History for details.${RST}"
}
Write-Host "${DIM}$LINE${RST}"
Write-Host ''
