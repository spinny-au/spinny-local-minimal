param(
  [Parameter(Mandatory=$true)][string]$IconFile,
  [Parameter(Mandatory=$true)][string]$StatusFile
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Read-TextFile([string]$Path, [string]$Fallback) {
  try {
    if (Test-Path -LiteralPath $Path) {
      $value = (Get-Content -LiteralPath $Path -Raw -Encoding UTF8).Trim()
      if ($value) { return $value }
    }
  } catch {}
  return $Fallback
}

# Load icon directly from .ico file — avoids all GC / HICON lifetime issues
$notify = New-Object System.Windows.Forms.NotifyIcon
$size = [System.Windows.Forms.SystemInformation]::SmallIconSize
$notify.Icon = New-Object System.Drawing.Icon($IconFile, $size.Width, $size.Height)
$notify.Text = "Spinny Local"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
$statusItem.Text = Read-TextFile $StatusFile "Pairing needed"
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$panelItem = New-Object System.Windows.Forms.ToolStripMenuItem
$panelItem.Text = "Open Local Panel"
$panelItem.Add_Click({
  [Console]::Out.WriteLine("panel")
  [Console]::Out.Flush()
})
[void]$menu.Items.Add($panelItem)

$webItem = New-Object System.Windows.Forms.ToolStripMenuItem
$webItem.Text = "Open spinny.au"
$webItem.Add_Click({
  [Console]::Out.WriteLine("web")
  [Console]::Out.Flush()
})
[void]$menu.Items.Add($webItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$quitItem.Text = "Quit"
$quitItem.Add_Click({
  [Console]::Out.WriteLine("quit")
  [Console]::Out.Flush()
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($quitItem)

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({
  [Console]::Out.WriteLine("panel")
  [Console]::Out.Flush()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  $statusItem.Text = Read-TextFile $StatusFile "Pairing needed"
})
$timer.Start()

[System.Windows.Forms.Application]::Run()

$timer.Stop()
$notify.Visible = $false
$notify.Dispose()
