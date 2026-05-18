$pid_f = "$env:LOCALAPPDATA\SpinnyLocal\spinny-local.pid"

if (Test-Path $pid_f) {
  $id = Get-Content $pid_f -ErrorAction SilentlyContinue
  if ($id) {
    Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue
    Write-Host "Spinny Local stopped (PID $id)"
  }
  Remove-Item $pid_f -Force
} else {
  Write-Host "No running Spinny Local instance found."
}
