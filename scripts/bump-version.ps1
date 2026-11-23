# Sets the version of the whole app: the workspace in Cargo.toml (servers and the Tauri app take it from there, the
# installer's name too) and client\package.json. Add the release to client\CHANGELOG.md: a test refuses a build without it.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 0.3.0
param([Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$utf8 = New-Object System.Text.UTF8Encoding $false

function Set-Version([string]$File, [string]$Pattern, [string]$Replacement) {
    $path = Join-Path $root $File
    $text = [IO.File]::ReadAllText($path)
    if ($text -notmatch $Pattern) { throw "No version in $File" }
    [IO.File]::WriteAllText($path, ([regex]::new($Pattern)).Replace($text, $Replacement, 1), $utf8)
}

Set-Version "Cargo.toml" '(?m)^version = "\d+\.\d+\.\d+"' "version = `"$Version`""
Set-Version "client\package.json" '"version": "\d+\.\d+\.\d+"' "`"version`": `"$Version`""

Push-Location $root
try {
    # Puts the new version into Cargo.lock.
    cargo update --workspace --offline --quiet
    if ($LASTEXITCODE -ne 0) { throw "cargo update failed" }
} finally {
    Pop-Location
}
Write-Host "HataVoice is now $Version. Add it to client\CHANGELOG.md."
