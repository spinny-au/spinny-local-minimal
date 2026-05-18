$root  = Split-Path $PSScriptRoot -Parent
$log   = "$env:LOCALAPPDATA\SpinnyLocal\spinny-local.log"
$pid_f = "$env:LOCALAPPDATA\SpinnyLocal\spinny-local.pid"

New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

# Kill any previous instance
if (Test-Path $pid_f) {
  $old = Get-Content $pid_f -ErrorAction SilentlyContinue
  if ($old) { Stop-Process -Id ([int]$old) -Force -ErrorAction SilentlyContinue }
  Remove-Item $pid_f -Force
}

$p = Start-Process -FilePath "node" `
  -ArgumentList "--experimental-sqlite --no-warnings `"$root\src\main.js`" start" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $log `
  -RedirectStandardError  $log `
  -PassThru

$p.Id | Set-Content $pid_f
Write-Host "Spinny Local started (PID $($p.Id))"
Write-Host "Logs: $log"
