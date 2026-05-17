param(
  [string]$InstallDir = "$env:LOCALAPPDATA\SpinnyLocalMinimal"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item -Recurse -Force "$PSScriptRoot\..\*" $InstallDir

$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\Spinny Local Minimal.cmd"
$cmd = "@echo off`r`ncd /d `"$InstallDir`"`r`nnpm start >> `"%LOCALAPPDATA%\SpinnyLocalMinimal\spinny-local.log`" 2>&1`r`n"
Set-Content -LiteralPath $startup -Value $cmd -Encoding ASCII

Write-Host "Installed Spinny Local Minimal to $InstallDir"
Write-Host "Startup command added at $startup"
Write-Host "Run: cd $InstallDir; npm run status"
