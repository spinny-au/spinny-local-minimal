param(
  [string]$InstallDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
)

$ErrorActionPreference = "Stop"

Write-Host "Spinny Local Minimal — Windows Installer"
Write-Host "========================================`n"

# Check Node.js
try {
  $nodeVersion = node --version 2>$null
  $nodeMajor = [int]($nodeVersion -replace 'v(\d+).*', '$1')
  $nodeMinor = [int]($nodeVersion -replace 'v\d+\.(\d+).*', '$1')
  if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 5)) {
    Write-Host "ERROR: Node.js 22.5 or higher is required (found $nodeVersion)"
    Write-Host "Download from: https://nodejs.org"
    exit 1
  }
  Write-Host "OK  Node.js $nodeVersion"
} catch {
  Write-Host "ERROR: Node.js is not installed."
  Write-Host "Download from: https://nodejs.org"
  exit 1
}

# Check Ollama
try {
  $null = ollama --version 2>$null
  Write-Host "OK  Ollama found"
} catch {
  Write-Host "ERROR: Ollama is not installed."
  Write-Host "Download from: https://ollama.com"
  exit 1
}

# Copy files
Write-Host "`nInstalling to $InstallDir..."
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item -Recurse -Force "$PSScriptRoot\..\*" $InstallDir
Write-Host "OK  Files copied"

# Register startup (starts ONLY if already paired)
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$startupPath = Join-Path $startupDir "Spinny Local Minimal.cmd"
$cmd = "@echo off`r`ncd /d `"$InstallDir`"`r`nnode --experimental-sqlite src/main.js status | findstr /C:`"paired`": true`" >nul 2>&1`r`nif %errorlevel% equ 0 npm start >> `"%LOCALAPPDATA%\SpinnyLocalMinimal\spinny-local.log`" 2>&1`r`n"
Set-Content -LiteralPath $startupPath -Value $cmd -Encoding ASCII
Write-Host "OK  Startup entry registered (runs only after pairing)"

Write-Host "`nInstalled successfully!`n"
Write-Host "Next steps:"
Write-Host "  1. Go to https://spinny.au → Settings → Local Node → Create pairing token"
Write-Host "  2. Run: cd `"$InstallDir`""
Write-Host "  3. Run: node --experimental-sqlite src/main.js pair --token <your-token>"
Write-Host "  4. Run: npm start"
Write-Host "`nAfter pairing, Spinny will start automatically on login."
