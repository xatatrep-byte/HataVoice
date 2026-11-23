# Downloads the official livekit-server for Windows into vendor\livekit and checks it against the SHA-256 kept in this
# repository (packaging\livekit.sha256): a checksum fetched from the same place as the file proves nothing if that place
# is compromised. A new version means a new line there, on purpose.
param([string]$Version = "1.13.10")

$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "..\vendor\livekit"
New-Item -ItemType Directory -Force $dir | Out-Null

$base = "https://github.com/livekit/livekit/releases/download/v$Version"
$zip = "livekit_${Version}_windows_amd64.zip"
$pinned = Select-String -Path (Join-Path $PSScriptRoot "..\packaging\livekit.sha256") -Pattern $zip -SimpleMatch
if (-not $pinned) { throw "No pinned checksum for $zip in packaging\livekit.sha256" }
$expected = $pinned.Line.Split(" ")[0]

Invoke-WebRequest -UseBasicParsing "$base/$zip" -OutFile (Join-Path $dir $zip)
$actual = (Get-FileHash (Join-Path $dir $zip) -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) {
    Remove-Item (Join-Path $dir $zip)
    throw "Checksum mismatch for ${zip}: expected $expected, got $actual"
}

Expand-Archive -Force (Join-Path $dir $zip) -DestinationPath $dir
Remove-Item (Join-Path $dir $zip)
Write-Host "livekit-server $Version is ready: $(Join-Path $dir 'livekit-server.exe')"
