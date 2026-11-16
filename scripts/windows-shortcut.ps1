# Creates a "Homelab Hub" app shortcut for Windows: it opens https://hub.example.com in its own Chrome
# window (no tabs, no address bar) with the hub's icon. The shortcut lands in the Start menu and on the
# desktop; pin it to the taskbar with: right-click it -> Show more options -> Pin to taskbar.
# (Windows has no supported way for a script to pin to the taskbar by itself.)
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\windows-shortcut.ps1
# Which Chrome profile opens it (it keeps that profile's Cloudflare Access login):
#   -ProfileEmail you@example.com   finds the profile signed in with that Google account
#   -ProfileDir "Profile 1"         or name the profile folder directly
# Without either, Chrome uses its last used profile.
param(
  [string]$Url = 'https://hub.example.com/',
  [string]$Name = 'Homelab Hub',
  [string]$ProfileEmail = '',
  [string]$ProfileDir = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$icoPath = Join-Path $assets 'homelab-hub.ico'

# --- icon: the same picture as public/favicon.svg, drawn at 256 x 256 ---
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$k = $size / 64.0
function RoundedRect($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#161b22'))
$g.FillPath($bg, (RoundedRect 0 0 $size $size (14 * $k)))
$line = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#8b949e')), (3 * $k)
$line.StartCap = 'Round'; $line.EndCap = 'Round'; $line.LineJoin = 'Round'
$g.DrawLines($line, [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF (26 * $k), (22 * $k)), (New-Object System.Drawing.PointF (34 * $k), (22 * $k)), (New-Object System.Drawing.PointF (38 * $k), (32 * $k))))
$g.DrawLines($line, [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF (26 * $k), (42 * $k)), (New-Object System.Drawing.PointF (34 * $k), (42 * $k)), (New-Object System.Drawing.PointF (38 * $k), (32 * $k))))
function Dot($cx, $cy, $color) {
  $b = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($color))
  $g.FillEllipse($b, ($cx - 6) * $k, ($cy - 6) * $k, 12 * $k, 12 * $k)
}
Dot 20 22 '#3fb950'
Dot 20 42 '#3fb950'
Dot 44 32 '#f85149'
$g.Dispose()

# .ico file with one 256 x 256 PNG image inside
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$bmp.Dispose()
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)          # reserved, type = icon, one image
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)  # 256 x 256, no palette
$w.Write([uint16]1); $w.Write([uint16]32)                              # planes, bits per pixel
$w.Write([uint32]$png.Length); $w.Write([uint32]22)                    # image size, offset
$w.Write($png)
$w.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())

# --- shortcuts ---
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LocalAppData\Google\Chrome\Application\chrome.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome was not found.' }

if ($ProfileEmail -and -not $ProfileDir) {
  $localState = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
  $cache = (Get-Content $localState -Raw | ConvertFrom-Json).profile.info_cache
  $match = $cache.PSObject.Properties | Where-Object { $_.Value.user_name -eq $ProfileEmail } | Select-Object -First 1
  if (-not $match) { throw "No Chrome profile is signed in with $ProfileEmail." }
  $ProfileDir = $match.Name
}
$profileArg = if ($ProfileDir) { "--profile-directory=`"$ProfileDir`" " } else { '' }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk"),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk")
)
foreach ($t in $targets) {
  $s = $shell.CreateShortcut($t)
  $s.TargetPath = $chrome
  $s.Arguments = "$profileArg--app=$Url"
  $s.WorkingDirectory = Split-Path $chrome
  $s.IconLocation = "$icoPath,0"
  $s.Description = "$Name ($Url)"
  $s.Save()
  Write-Output "created $t"
}
Write-Output "icon: $icoPath"
Write-Output "chrome profile: $(if ($ProfileDir) { $ProfileDir } else { '(last used)' })"
