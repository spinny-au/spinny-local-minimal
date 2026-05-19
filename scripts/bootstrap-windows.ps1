# Spinny Local Minimal — One-command bootstrap for Windows
#
# Install (default):
#   irm https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/bootstrap-windows.ps1 | iex
#
# Fresh install (wipes install dir + state, forces re-pair):
#   & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/bootstrap-windows.ps1'))) --fresh
#
# Update only (pull latest, restart — keeps pairing):
#   & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/bootstrap-windows.ps1'))) --update

param(
  [switch]$fresh,
  [switch]$update
)

# Accept bash-style --fresh / --update as well as PowerShell-style -fresh / -update
if ($args -contains '--fresh')  { $fresh  = $true }
if ($args -contains '--update') { $update = $true }

$ErrorActionPreference = "Stop"

$InstallDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
$StateFile  = "$env:USERPROFILE\.spinny-local\state.json"

function Write-Step { param($msg) Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "   --  $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "   !!  $msg" -ForegroundColor Red }

function Stop-SpinnyProcess {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like "*SpinnyLocalMinimal*" }
  foreach ($p in $procs) {
    Write-Warn "Stopping running Spinny process (PID $($p.ProcessId))..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($procs) { Start-Sleep -Seconds 1 }
}

function Write-Shortcut {
  $iconB64 = "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"
  $iconPath = Join-Path $InstallDir "spinny.ico"
  [System.IO.File]::WriteAllBytes($iconPath, [System.Convert]::FromBase64String($iconB64))
  $shortcutPath = "$env:USERPROFILE\Desktop\Spinny Local.url"
  $urlContent = "[InternetShortcut]`r`nURL=http://localhost:47821`r`nIconIndex=0`r`nIconFile=$iconPath`r`n"
  Set-Content -LiteralPath $shortcutPath -Value $urlContent -Encoding ASCII
  Write-Ok "Desktop shortcut created"
}

function Register-Startup {
  # VBScript wrapper — launches node silently with no console window so the
  # startup folder entry doesn't flash a terminal on login.
  $startupDir  = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
  $startupPath = Join-Path $startupDir "Spinny Local Minimal.vbs"
  $logFile     = "$env:LOCALAPPDATA\SpinnyLocalMinimal\spinny-local.log"
  $vbs = @"
Dim oShell
Set oShell = WScript.CreateObject("WScript.Shell")
oShell.CurrentDirectory = "$InstallDir"
oShell.Run "node --experimental-sqlite --no-warnings src\main.js start >> ""$logFile"" 2>&1", 0, False
"@
  Set-Content -LiteralPath $startupPath -Value $vbs -Encoding ASCII
  Write-Ok "Will start automatically on login (hidden, no terminal window)"
}

function Start-SpinnyBackground {
  $logDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
  $logFile = "$logDir\spinny-local.log"
  $pidFile = "$logDir\spinny-local.pid"
  New-Item -ItemType Directory -Force $logDir | Out-Null
  # Kill any previous instance recorded in the pid file
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  $p = Start-Process -FilePath "node" `
    -ArgumentList "--experimental-sqlite --no-warnings src/main.js start" `
    -WorkingDirectory $InstallDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError  $logFile `
    -PassThru
  $p.Id | Set-Content $pidFile
  Write-Ok "Spinny is running in the background (PID $($p.Id))"
  Write-Ok "You can close this terminal — the node stays alive."
  Write-Ok "Logs: $logFile"
}

# ── Header ────────────────────────────────────────────────────────────────────
Write-Host ""
if ($fresh) {
  Write-Host "  Spinny Local Minimal — Fresh Install" -ForegroundColor White
  Write-Host "  =====================================" -ForegroundColor White
  Write-Host "  This will wipe the existing install and reset pairing." -ForegroundColor Yellow
} elseif ($update) {
  Write-Host "  Spinny Local Minimal — Update" -ForegroundColor White
  Write-Host "  ==============================" -ForegroundColor White
} else {
  Write-Host "  Spinny Local Minimal — Bootstrap Installer" -ForegroundColor White
  Write-Host "  ===========================================" -ForegroundColor White
}
Write-Host ""

# ══ UPDATE MODE ══════════════════════════════════════════════════════════════
if ($update) {
  if (-not (Test-Path "$InstallDir\.git")) {
    Write-Fail "No existing install found at $InstallDir — run without --update to install first."
    exit 1
  }
  Write-Step "Stopping running Spinny process..."
  Stop-SpinnyProcess
  Write-Ok "Stopped"

  Write-Step "Pulling latest code..."
  git -C $InstallDir pull --ff-only
  Write-Ok "Code updated"

  Write-Step "Installing dependencies..."
  Set-Location $InstallDir
  npm install --silent 2>$null
  Write-Ok "Dependencies ready"

  Write-Step "Building local panel UI..."
  Set-Location "$InstallDir\ui"
  npm install --silent 2>$null
  npm run build --silent 2>$null
  Set-Location $InstallDir
  Write-Ok "Local panel ready"

  Write-Shortcut
  Register-Startup

  Write-Host ""
  Write-Host "  Updated! Starting Spinny..." -ForegroundColor Green
  Write-Host ""
  Set-Location $InstallDir
  Start-SpinnyBackground
  exit
}

# ── 1. winget ─────────────────────────────────────────────────────────────────
Write-Step "Checking package manager (winget)..."
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Fail "winget not found. Please update Windows or install App Installer from the Microsoft Store."
  exit 1
}
Write-Ok "winget available"

# ── 2. Git ────────────────────────────────────────────────────────────────────
Write-Step "Checking Git..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warn "Git not found — installing..."
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements -h
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Ok "Git $(git --version)"

# ── 3. Node.js ────────────────────────────────────────────────────────────────
Write-Step "Checking Node.js (22.5+ required)..."
$needsNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = node --version
  $major = [int]($v -replace 'v(\d+).*','$1')
  $minor = [int]($v -replace 'v\d+\.(\d+).*','$1')
  if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 5)) {
    Write-Ok "Node.js $v"
    $needsNode = $false
  } else {
    Write-Warn "Node.js $v is too old — upgrading..."
  }
}
if ($needsNode) {
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements -h
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
  Write-Ok "Node.js $(node --version)"
}

# ── 4. Ollama ─────────────────────────────────────────────────────────────────
Write-Step "Checking Ollama..."
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Warn "Ollama not found — installing..."
  winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements -h
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Ok "Ollama found"

# ── 5. Clone / fresh-wipe / update repo ──────────────────────────────────────
Write-Step "Setting up Spinny Local Minimal..."
if ($fresh) {
  Write-Warn "Stopping any running Spinny process..."
  Stop-SpinnyProcess
  # Kill any remaining node processes that may hold file handles
  try { & cmd /c "taskkill /F /IM node.exe /T >nul 2>&1" } catch {}
  Start-Sleep -Seconds 2
  Set-Location $env:USERPROFILE
  if (Test-Path $InstallDir) {
    Write-Warn "Removing existing install..."
    # Use cmd rmdir — more aggressive than Remove-Item, releases OS directory handles
    & cmd /c rmdir /s /q $InstallDir
  }
  if (Test-Path $StateFile) {
    Write-Warn "Clearing pairing state..."
    Remove-Item -Force $StateFile
  }
  git clone https://github.com/spinny-au/spinny-local-minimal.git $InstallDir
  Write-Ok "Fresh clone complete"
} elseif (Test-Path "$InstallDir\.git") {
  Write-Warn "Existing install found — updating..."
  git -C $InstallDir pull --ff-only
  Write-Ok "Files updated"
} else {
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  git clone https://github.com/spinny-au/spinny-local-minimal.git $InstallDir
  Write-Ok "Files ready"
}

# ── 6. Install dependencies ───────────────────────────────────────────────────
Write-Step "Installing dependencies..."
Set-Location $InstallDir
npm install --silent 2>$null
Write-Ok "Dependencies ready"

# ── 6b. Build React UI ────────────────────────────────────────────────────────
Write-Step "Building local panel UI..."
Set-Location "$InstallDir\ui"
npm install --silent 2>$null
npm run build --silent 2>$null
Set-Location $InstallDir
Write-Ok "Local panel ready"

# ── 7. Register startup ───────────────────────────────────────────────────────
Write-Step "Registering auto-start on login..."
Register-Startup

# ── 8. Done — launch ──────────────────────────────────────────────────────────
$alreadyPaired = $false
if (-not $fresh -and (Test-Path $StateFile)) {
  try {
    $s = Get-Content $StateFile -Raw | ConvertFrom-Json
    if ($s.paired -eq $true) { $alreadyPaired = $true }
  } catch {}
}

Write-Host ""
if ($fresh) {
  Write-Host "  Fresh install complete! Starting Spinny now..." -ForegroundColor Green
  Write-Host "  A new pairing code will appear below." -ForegroundColor White
} elseif ($alreadyPaired) {
  Write-Host "  All done! This machine is already paired." -ForegroundColor Green
  Write-Host "  Starting local node..." -ForegroundColor White
} else {
  Write-Host "  All done! Starting Spinny now..." -ForegroundColor Green
  Write-Host "  A pairing code will appear below — enter it on spinny.au." -ForegroundColor White
}
Write-Host ""

Write-Shortcut

Set-Location $InstallDir
Start-SpinnyBackground
