# Spinny Local Minimal — One-command bootstrap for Windows
# Usage: irm https://raw.githubusercontent.com/foreverdada6126/spinny-local-minimal/main/scripts/bootstrap-windows.ps1 | iex

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

# ── 5. Clone repo ────────────────────────────────────────────────────────────
$InstallDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
Write-Step "Cloning spinny-local-minimal to $InstallDir..."
if (Test-Path $InstallDir) {
  Write-Warn "Directory exists — pulling latest..."
  git -C $InstallDir pull --ff-only
} else {
  git clone https://github.com/foreverdada6126/spinny-local-minimal.git $InstallDir
}
Write-Ok "Repo ready"

# ── 6. Register startup ──────────────────────────────────────────────────────
Write-Step "Registering startup entry..."
$startupDir  = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$startupPath = Join-Path $startupDir "Spinny Local Minimal.cmd"
$cmd = "@echo off`r`ncd /d `"$InstallDir`"`r`nnode --experimental-sqlite src/main.js status | findstr /C:`"paired`": true`" >nul 2>&1`r`nif %errorlevel% equ 0 npm start >> `"%LOCALAPPDATA%\SpinnyLocalMinimal\spinny-local.log`" 2>&1`r`n"
Set-Content -LiteralPath $startupPath -Value $cmd -Encoding ASCII
Write-Ok "Will auto-start on login once paired"

# ── 7. Run doctor ────────────────────────────────────────────────────────────
Write-Step "Running health check..."
Set-Location $InstallDir
node --experimental-sqlite src/main.js doctor

# ── 8. Done ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next step — pair this node with your Spinny account:" -ForegroundColor White
Write-Host ""
Write-Host "    1. Go to https://spinny.au → Settings → Local Node → Create pairing token"
Write-Host "    2. Run this command (replace the token):"
Write-Host ""
Write-Host "       cd `"$InstallDir`"" -ForegroundColor Yellow
Write-Host "       node --experimental-sqlite src/main.js pair --token <your-token>" -ForegroundColor Yellow
Write-Host ""
Write-Host "    3. Then start:"
Write-Host ""
Write-Host "       npm start" -ForegroundColor Yellow
Write-Host ""
