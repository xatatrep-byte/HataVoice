# Builds the Windows installer: release hatavoice-server + LiveKit bundled next to the client.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1
param([string]$LiveKit = "")

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

# A release build names the folders its code came from (in its error messages): the user's own folder and the project's
# path are swapped for neutral names, so a published installer says nothing of who built it or where. When several
# match, rustc takes the last, so the most specific goes last.
$remap = @("--remap-path-prefix=$env:USERPROFILE=/home", "--remap-path-prefix=$env:USERPROFILE\.cargo=/cargo", "--remap-path-prefix=$root=/hatavoice")
$env:RUSTFLAGS = (@($env:RUSTFLAGS) + $remap | Where-Object { $_ }) -join " "
# The C code built along (aws-lc) writes its file names too, and rustc's remap does not reach it: MSVC trims the user's
# folder from them (in its short 8.3 form as well, which aws-lc's build uses).
$short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:USERPROFILE).ShortPath
$trim = @("/d1trimfile:$env:USERPROFILE\", "/d1trimfile:$short\") | Select-Object -Unique
$env:CFLAGS = (@($env:CFLAGS) + $trim | Where-Object { $_ }) -join " "
$env:CXXFLAGS = (@($env:CXXFLAGS) + $trim | Where-Object { $_ }) -join " "
if ($LiveKit -eq "") { $LiveKit = Join-Path $root "vendor\livekit\livekit-server.exe" }
if (-not (Test-Path $LiveKit)) {
    & (Join-Path $PSScriptRoot "get-livekit.ps1")
}

# The app icon is compiled with rc.exe, which embed-resource finds through the registry and Visual
# Studio; that lookup breaks on some setups, so point it straight at the newest Windows SDK.
if (-not $env:RC) {
    $rc = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\rc.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName | Select-Object -Last 1
    if ($rc) { $env:RC = $rc.FullName }
}

# Tauri sidecars are named with the Rust target triple, e.g. hatavoice-server-x86_64-pc-windows-msvc.exe.
$triple = ((rustc -vV) | Select-String "^host:").Line.Split(" ")[1]
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root "target" }

Push-Location $root
try {
    cargo build --release -p hatavoice-server
    if ($LASTEXITCODE -ne 0) { throw "server build failed" }
} finally {
    Pop-Location
}

& (Join-Path $PSScriptRoot "smoke-server.ps1") -Server (Join-Path $target "release\hatavoice-server.exe") -LiveKit $LiveKit

$binaries = Join-Path $root "client\src-tauri\binaries"
New-Item -ItemType Directory -Force $binaries | Out-Null
Copy-Item (Join-Path $target "release\hatavoice-server.exe") (Join-Path $binaries "hatavoice-server-$triple.exe") -Force
Copy-Item $LiveKit (Join-Path $binaries "livekit-server-$triple.exe") -Force

$key = Join-Path $root "vendor\release\release.key"
$version = ((Select-String -Path (Join-Path $root "Cargo.toml") -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value)

# The Android package of this very version, if one was built (packaging/android): sealed apart with the publisher's key
# (its own signature covers the whole file, so the seal cannot go at its end) and carried by the installer, so the server
# hands it to friends' phones as it hands this installer to their PCs.
$update = Join-Path $root "client\src-tauri\update"
if (Test-Path $update) { Remove-Item -Recurse -Force $update }
$apk = Join-Path $root "dist\HataVoice_${version}_android-arm64.apk"
$extra = @()
if (Test-Path $apk) {
    New-Item -ItemType Directory -Force $update | Out-Null
    Copy-Item $apk (Join-Path $update "HataVoice-android.apk") -Force
    Push-Location $root
    try {
        cargo run --release --quiet -p hv-roster --example seal_release -- seal-apart $key (Join-Path $update "HataVoice-android.apk") $version (Join-Path $update "HataVoice-android.seal")
        if ($LASTEXITCODE -ne 0) { throw "sealing the Android package failed" }
    } finally {
        Pop-Location
    }
    $resources = '{"bundle":{"resources":{"update/HataVoice-android.apk":"update/HataVoice-android.apk","update/HataVoice-android.seal":"update/HataVoice-android.seal"}}}'
    [System.IO.File]::WriteAllText((Join-Path $update "bundle.json"), $resources)
    $extra = @("--config", "src-tauri/update/bundle.json")
    Write-Host "The Android package $version goes into the installer for friends' phones"
}

Push-Location (Join-Path $root "client")
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    pnpm tauri build --config src-tauri/tauri.bundle.conf.json @extra
    if ($LASTEXITCODE -ne 0) { throw "installer build failed" }
} finally {
    Pop-Location
}

$installer = Get-ChildItem (Join-Path $target "release\bundle\nsis\*-setup.exe") | Sort-Object LastWriteTime | Select-Object -Last 1

# The version and the publisher's signature go to the very end of the file: friends' programs refuse anything without them.
Push-Location $root
try {
    cargo run --release --quiet -p hv-roster --example seal_release -- seal $key $installer.FullName $version
    if ($LASTEXITCODE -ne 0) { throw "sealing failed" }
} finally {
    Pop-Location
}
Write-Host "Installer ready: $($installer.FullName)"
