param(
  [Parameter(Mandatory=$true)][string]$IconBase64File,
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

function New-IconFromBase64([string]$Path) {
  $raw = Read-TextFile $Path ""
  if ($raw.StartsWith("data:image")) {
    $raw = $raw.Substring($raw.IndexOf(",") + 1)
  }
  $bytes  = [Convert]::FromBase64String($raw)
  $stream = New-Object System.IO.MemoryStream(,$bytes)
  $src    = New-Object System.Drawing.Bitmap($stream)

  # Scale to the DPI-aware tray icon size with high-quality interpolation
  $side   = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  $canvas = New-Object System.Drawing.Bitmap($side, $side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g      = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src, 0, 0, $side, $side)
  $g.Dispose()

  # Pin to script scope — if the Bitmap is GC'd the HICON becomes dangling
  $script:_TrayIconBitmap = $canvas
  $hicon  = $canvas.GetHicon()
  return [System.Drawing.Icon]::FromHandle($hicon)
}

# Keep a script-level reference so the GC never collects the Bitmap whose
# pixel data backs the HICON — a collected Bitmap corrupts the tray icon.
$script:_TrayIconBitmap = $null

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-IconFromBase64 $IconBase64File
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
