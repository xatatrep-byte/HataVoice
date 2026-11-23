# Renders ХатаВойс's icon from tools/icon/icon.html with headless Edge (nothing to install): the 1024 px picture for
# `tauri icon` (Windows, Mac), and Android's adaptive icon layers per density into packaging/android/overlay.
# Usage (repository root, PowerShell): & .\tools\icon\render.ps1   then   node client\node_modules\@tauri-apps\cli\tauri.js icon tools\icon\out\desktop-1024.png --output <tmp>
# and copy the desktop files from <tmp> into client\src-tauri\icons (not the android/ios folders).
$ErrorActionPreference = "Continue"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
$here = $PSScriptRoot
$out = Join-Path $here "out"
$res = Join-Path $here "..\..\packaging\android\overlay\app\src\main\res"
New-Item -ItemType Directory -Force $out | Out-Null
$page = "file:///" + ($here -replace '\', '/') + "/icon.html"
$jobs = @(,@("desktop", 1024, (Join-Path $out "desktop-1024.png")))
$dens = @{ "mdpi" = 1; "hdpi" = 1.5; "xhdpi" = 2; "xxhdpi" = 3; "xxxhdpi" = 4 }
foreach ($k in $dens.Keys) {
  $f = $dens[$k]
  $dir = Join-Path $res "mipmap-$k"
  $jobs += ,@("fg", [int](108 * $f), (Join-Path $dir "ic_launcher_foreground.png"))
  $jobs += ,@("mono", [int](108 * $f), (Join-Path $dir "ic_launcher_monochrome.png"))
  $jobs += ,@("legacy", [int](48 * $f), (Join-Path $dir "ic_launcher.png"))
  $jobs += ,@("round", [int](48 * $f), (Join-Path $dir "ic_launcher_round.png"))
}
foreach ($j in $jobs) {
  New-Item -ItemType Directory -Force (Split-Path $j[2]) | Out-Null
  $size = $j[1]
  & $edge --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 --screenshot="$($j[2])" --window-size="$size,$size" "$page`?kind=$($j[0])&size=$size" 2>$null | Out-Null
}
