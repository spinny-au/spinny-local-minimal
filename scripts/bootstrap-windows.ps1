# Spinny Local Minimal — One-command bootstrap for Windows
# Usage: irm https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/bootstrap-windows.ps1 | iex

$ErrorActionPreference = "Stop"

function Write-Step { param($msg) Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "   --  $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "   !!  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  Spinny Local Minimal — Bootstrap Installer" -ForegroundColor White
Write-Host "  ===========================================" -ForegroundColor White
Write-Host ""

# ── 1. winget ────────────────────────────────────────────────────────────────
Write-Step "Checking package manager (winget)..."
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Fail "winget not found. Please update Windows or install App Installer from the Microsoft Store."
  exit 1
}
Write-Ok "winget available"

# ── 2. Git ───────────────────────────────────────────────────────────────────
Write-Step "Checking Git..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warn "Git not found — installing..."
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements -h
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Ok "Git $(git --version)"

# ── 3. Node.js ───────────────────────────────────────────────────────────────
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

# ── 4. Ollama ────────────────────────────────────────────────────────────────
Write-Step "Checking Ollama..."
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Warn "Ollama not found — installing..."
  winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements -h
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}
Write-Ok "Ollama found"

# ── 5. Clone or update repo ──────────────────────────────────────────────────
$InstallDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
Write-Step "Setting up Spinny Local Minimal..."
if (Test-Path "$InstallDir\.git") {
  Write-Warn "Existing install found — updating..."
  git -C $InstallDir pull --ff-only
} else {
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  git clone https://github.com/spinny-au/spinny-local-minimal.git $InstallDir
}
Write-Ok "Files ready"

# ── 6. Install dependencies (always — idempotent) ────────────────────────────
Write-Step "Installing dependencies..."
Set-Location $InstallDir
npm install --silent 2>$null
Write-Ok "Dependencies ready"

# ── 7. Register startup ──────────────────────────────────────────────────────
Write-Step "Registering auto-start on login..."
$startupDir  = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$startupPath = Join-Path $startupDir "Spinny Local Minimal.cmd"
$cmd = "@echo off`r`ncd /d `"$InstallDir`"`r`nnpm start >> `"%LOCALAPPDATA%\SpinnyLocalMinimal\spinny-local.log`" 2>&1`r`n"
Set-Content -LiteralPath $startupPath -Value $cmd -Encoding ASCII
Write-Ok "Will start automatically on login"

# ── 8. Done — launch ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  All done! Starting Spinny now..." -ForegroundColor Green
Write-Host "  Scan the QR code with your phone to pair this machine." -ForegroundColor White
Write-Host ""

Set-Location $InstallDir
node --experimental-sqlite --no-warnings src/main.js start
