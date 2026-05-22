# Spinny Local Node — Windows Installer
# Run from PowerShell (Admin recommended):
#   irm https://spinny.au/install.ps1 | iex
#
# Or with email pre-filled:
#   & ([scriptblock]::Create((irm https://spinny.au/install.ps1))) -Email you@example.com

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal",
  [string]$Email = ""
)

$ErrorActionPreference = "Stop"
$StateDir = "$env:USERPROFILE\.spinny-local"
$StateFile = "$StateDir\state.json"
$LogFile = "$InstallDir\spinny-local.log"

# ── Colours ───────────────────────────────────────────────────────────────────
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Step($msg) { Write-Host "`n  >> $msg" -ForegroundColor Cyan }
function Write-Fail($msg) { Write-Host "  [X] $msg" -ForegroundColor Red; exit 1 }

Clear-Host
Write-Host ""
Write-Host "  =============================================================" -ForegroundColor DarkGray
Write-Host "   SPINNY LOCAL NODE  -  Windows Installer" -ForegroundColor White
Write-Host "  =============================================================" -ForegroundColor DarkGray
Write-Host ""

# ── 1. Node.js ────────────────────────────────────────────────────────────────
Write-Step "Checking Node.js"
try {
  $nodeVersion = node --version 2>$null
  $nodeMajor = [int]($nodeVersion -replace 'v(\d+).*', '$1')
  if ($nodeMajor -lt 22) {
    Write-Fail "Node.js 22+ required (found $nodeVersion). Download from: https://nodejs.org"
  }
  Write-Ok "Node.js $nodeVersion"
} catch {
  Write-Fail "Node.js not found. Download from: https://nodejs.org"
}

# ── 2. Git ────────────────────────────────────────────────────────────────────
Write-Step "Checking Git"
try {
  $gitVersion = git --version 2>$null
  Write-Ok $gitVersion
} catch {
  Write-Fail "Git not found. Download from: https://git-scm.com"
}

# ── 3. Clone / update repo ────────────────────────────────────────────────────
Write-Step "Installing Spinny"
$RepoUrl = "https://github.com/spinny-au/spinny-local-minimal.git"

if (Test-Path "$InstallDir\.git") {
  Write-Host "  Updating existing install..." -ForegroundColor DarkGray
  git -C $InstallDir pull --quiet
  Write-Ok "Updated"
} else {
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  git clone --quiet $RepoUrl $InstallDir
  Write-Ok "Cloned"
}

Write-Step "Installing dependencies"
Push-Location $InstallDir
npm install --silent 2>$null
Pop-Location
Write-Ok "Dependencies ready"

# ── 4. State dir ─────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force $StateDir | Out-Null

# ── 5. Node name ─────────────────────────────────────────────────────────────
$EnvFile = "$InstallDir\.env"
$NodeSlug = ($env:COMPUTERNAME -replace '[^a-zA-Z0-9]', '-').ToLower()
$NodeName = "spinny-$NodeSlug"
if (Test-Path $EnvFile) {
  $existing = (Get-Content $EnvFile | Where-Object { $_ -match '^SPINNY_NODE_NAME=' } | Select-Object -Last 1) -replace '^SPINNY_NODE_NAME=', ''
  if ($existing) { $NodeName = $existing }
}
$envContent = if (Test-Path $EnvFile) { Get-Content $EnvFile | Where-Object { $_ -notmatch '^SPINNY_NODE_NAME=' } } else { @() }
$envContent += "SPINNY_NODE_NAME=$NodeName"
$envContent | Set-Content $EnvFile -Encoding utf8

# ── 6. spinny.cmd CLI wrapper ─────────────────────────────────────────────────
Write-Step "Installing spinny CLI"
$CliPath = "$InstallDir\spinny.cmd"
$NodeFlags = "--experimental-sqlite --no-warnings --env-file-if-exists=.env"
@"
@echo off
cd /d "$InstallDir"
node $NodeFlags src\main.js %*
"@ | Set-Content $CliPath -Encoding ASCII

# Add InstallDir to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('PATH', "$userPath;$InstallDir", 'User')
  $env:PATH += ";$InstallDir"
  Write-Ok "Added to PATH: $InstallDir"
} else {
  Write-Ok "Already on PATH"
}

# ── 7. Background service (Task Scheduler) ────────────────────────────────────
Write-Step "Registering startup task"
$TaskName = "SpinnyLocalNode"
$NodeBin = (Get-Command node).Source
$startCmd = "`"$NodeBin`" $NodeFlags src\main.js start >> `"$LogFile`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $startCmd" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
  Write-Ok "Task registered (runs at login)"
} catch {
  Write-Warn "Could not register startup task (non-admin). Start manually with: spinny start"
}

# ── 8. System info ────────────────────────────────────────────────────────────
$CpuCount = (Get-WmiObject Win32_ComputerSystem).NumberOfLogicalProcessors
$RamGB = [math]::Round((Get-WmiObject Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$DiskFree = [math]::Round((Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / 1GB, 0)
$NodeVer = node -p "require('$InstallDir/package.json').version" 2>$null
$GitSha = git -C $InstallDir rev-parse --short HEAD 2>$null

# ── 9. Start daemon ───────────────────────────────────────────────────────────
Write-Step "Starting Spinny"
$proc = Start-Process -FilePath "node" `
  -ArgumentList "$NodeFlags src\main.js start" `
  -WorkingDirectory $InstallDir `
  -RedirectStandardOutput $LogFile `
  -RedirectStandardError  $LogFile `
  -NoNewWindow -PassThru
Write-Ok "Daemon started (PID $($proc.Id))"

# Wait for pairing code to appear in log
$PairingCode = ""
$Paired = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  if (Test-Path $StateFile) {
    $state = Get-Content $StateFile -Raw | ConvertFrom-Json
    if ($state.paired -eq $true) { $Paired = $true; break }
    if ($state.pairingCode) { $PairingCode = $state.pairingCode }
  }
  if (!$PairingCode -and (Test-Path $LogFile)) {
    $match = Select-String -Path $LogFile -Pattern '\[relay-pair\] advertise ([A-Z0-9]+) ->' | Select-Object -Last 1
    if ($match) { $PairingCode = $match.Matches[0].Groups[1].Value }
  }
  if ($PairingCode -or $Paired) { break }
}

# ── 10. Banner ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  =============================================================" -ForegroundColor DarkGray
Write-Host "   SPINNY LOCAL NODE  v$NodeVer ($GitSha)  INSTALLED" -ForegroundColor White
Write-Host "  =============================================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Node name  : $NodeName"
Write-Host "  Hardware   : $CpuCount vCPUs  *  $RamGB GB  *  ${DiskFree}G free"
Write-Host "  Status     : Running"
Write-Host "  Node UI    : http://localhost:47821"
Write-Host ""
Write-Host "  =============================================================" -ForegroundColor DarkGray

if ($Paired) {
  Write-Host "  Already paired. Open spinny.au to start using Spinny." -ForegroundColor Green
  Write-Host "  =============================================================" -ForegroundColor DarkGray
} else {
  Write-Host "  Node is ready. Enter your spinny.au email to pair:" -ForegroundColor White
  Write-Host "  =============================================================" -ForegroundColor DarkGray
  Write-Host ""

  if ([string]::IsNullOrEmpty($Email)) {
    $Email = Read-Host "  Email"
  } else {
    Write-Host "  Email: $Email"
  }
  $Email = $Email.Trim().ToLower()

  if ([string]::IsNullOrEmpty($Email) -or $Email -notmatch '@') {
    Write-Warn "No email entered — pair later with: spinny pairme2 <email>"
    if ($PairingCode) {
      Write-Host "  Backup: enter code $PairingCode at spinny.au -> Settings -> Local Node" -ForegroundColor DarkGray
    }
  } else {
    Write-Host ""
    Write-Host "  Sending pairing request to $Email..." -ForegroundColor Cyan

    # Run pairme2 in background
    $pairProc = Start-Process -FilePath "node" `
      -ArgumentList "$NodeFlags src\main.js pairme2 `"$Email`"" `
      -WorkingDirectory $InstallDir `
      -RedirectStandardOutput "$env:TEMP\spinny-pairme2.log" `
      -NoNewWindow -PassThru

    Write-Host ""
    Write-Host "  Waiting for approval on spinny.au" -NoNewline -ForegroundColor Yellow
    $PairSuccess = $false
    for ($i = 0; $i -lt 180; $i++) {
      Start-Sleep 1
      if (Test-Path $StateFile) {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        if ($state.paired -eq $true) { $PairSuccess = $true; break }
      }
      if ($i % 2 -eq 0) { Write-Host "." -NoNewline }
    }

    try { $pairProc | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
    Write-Host ""
    Write-Host ""

    if ($PairSuccess) {
      $state = Get-Content $StateFile -Raw | ConvertFrom-Json
      $pairedAs = if ($state.accountId) { $state.accountId } else { $Email }
      Write-Host "  =============================================================" -ForegroundColor DarkGray
      Write-Host "  [OK] Node paired as $pairedAs" -ForegroundColor Green
      Write-Host "  =============================================================" -ForegroundColor DarkGray
      Write-Host ""
      Write-Host "  Your node is live at spinny.au"
      Write-Host ""
      Write-Host "  Pair again later  : spinny pairme2 $Email" -ForegroundColor DarkGray
      Write-Host "  Get pairing code  : spinny pairingcode" -ForegroundColor DarkGray
    } else {
      Write-Host "  =============================================================" -ForegroundColor DarkGray
      Write-Warn "Approval pending — open spinny.au to approve"
      Write-Host "  =============================================================" -ForegroundColor DarkGray
      Write-Host ""
      Write-Host "  The request was sent to $Email."
      Write-Host "  Open spinny.au and approve the pairing request."
      if ($PairingCode) {
        Write-Host ""
        Write-Host "  Backup code: $PairingCode  (spinny.au -> Settings -> Local Node -> Connect)" -ForegroundColor DarkGray
      }
    }
  }
}
Write-Host ""
