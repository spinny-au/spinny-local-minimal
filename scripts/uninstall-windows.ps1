#Requires -Version 5.1
# Spinny Local Node — Windows uninstaller
#
# Removes the app completely but PRESERVES your encrypted vault (%USERPROFILE%\.spinny-local\).
# You can reinstall anytime and your data will be restored automatically.
#
# Run in PowerShell:
#   & ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/spinny-au/spinny-local-minimal/main/scripts/uninstall-windows.ps1')))

$ErrorActionPreference = 'SilentlyContinue'

$INSTALL_DIR = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
$DATA_DIR    = "$env:USERPROFILE\.spinny-local"
$TASK_NAME   = 'SpinnyLocalNode'
$SHORTCUT    = "$env:USERPROFILE\Desktop\Spinny Local.url"

$e = [char]27
$R   = "$e[0;31m"; $G = "$e[0;32m"; $Y = "$e[1;33m"
$C   = "$e[0;36m"; $B = "$e[1m";    $DIM = "$e[2m"; $RST = "$e[0m"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function step($m) { Write-Host "`n${C}${B}▶ $m${RST}" }
function ok($m)   { Write-Host "${G}✓ $m${RST}" }
function warn($m) { Write-Host "${Y}⚠ $m${RST}" }

Write-Host ""
Write-Host "${Y}${B}  Spinny Local Node — Uninstaller${RST}"
Write-Host "${DIM}  This will remove the Spinny app but KEEP your encrypted data.${RST}"
Write-Host ""
Write-Host "  ${B}Will be removed:${RST}"
Write-Host "    • App files       → $INSTALL_DIR"
Write-Host "    • Task Scheduler  → $TASK_NAME"
Write-Host "    • Desktop shortcut"
Write-Host ""
Write-Host "  ${B}Will be preserved:${RST}"
Write-Host "    • Vault & state → $DATA_DIR  ${G}(AES-256 encrypted)${RST}"
Write-Host ""
$confirm = Read-Host "  Continue? [y/N]"
if ($confirm -notmatch '^[Yy]$') { Write-Host "Cancelled."; exit 0 }

# 1. Stop & remove scheduled task
step "Stopping Spinny service"
$task = Get-ScheduledTask -TaskName $TASK_NAME -EA SilentlyContinue
if ($task) {
    Stop-ScheduledTask  -TaskName $TASK_NAME -EA SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -EA SilentlyContinue
    ok "Task '$TASK_NAME' removed"
} else {
    warn "Scheduled task not found — may have been removed already"
}

# 2. Kill any stray node processes running from the install dir
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -like "*SpinnyLocalMinimal*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }

# 3. Remove app directory
step "Removing app files"
if (Test-Path $INSTALL_DIR) {
    # Use cmd rmdir to handle long paths and locked files better
    & cmd /c "rmdir /s /q `"$INSTALL_DIR`"" 2>$null
    if (-not (Test-Path $INSTALL_DIR)) {
        ok "Removed $INSTALL_DIR"
    } else {
        # Fallback: PowerShell remove
        Remove-Item -Recurse -Force $INSTALL_DIR -EA SilentlyContinue
        ok "Removed $INSTALL_DIR"
    }
} else {
    warn "Install directory not found — already removed?"
}

# 4. Remove desktop shortcut
if (Test-Path $SHORTCUT) {
    Remove-Item $SHORTCUT -Force -EA SilentlyContinue
    ok "Desktop shortcut removed"
}

# 5. Summary
Write-Host ""
Write-Host "${DIM}$('=' * 68)${RST}"
Write-Host "  ${G}${B}✓ Spinny Local Node removed${RST}"
Write-Host ""
Write-Host "  Your encrypted vault is intact at:"
Write-Host "  ${B}$DATA_DIR${RST}"
Write-Host ""
Write-Host "  ${DIM}Files in this directory are AES-256 encrypted with a key derived${RST}"
Write-Host "  ${DIM}from your hardware. They are unreadable without your machine.${RST}"
Write-Host "  ${DIM}Reinstall anytime — your history and credentials restore automatically.${RST}"
Write-Host ""
Write-Host "  To also erase all data (irreversible):"
Write-Host "    ${R}Remove-Item -Recurse -Force `"$DATA_DIR`"${RST}"
Write-Host "${DIM}$('=' * 68)${RST}"
Write-Host ""
