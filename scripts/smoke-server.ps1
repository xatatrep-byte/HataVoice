# Starts the very binary that goes into the installer, on test ports with UPnP off, and fails if it dies or does not listen.
# Tests cannot catch this: `cargo test` and a build together with the client unify features, a release server built alone does not.
# (0.5.0 and 0.6.0 shipped a server that panicked two seconds after starting.)
param(
    [Parameter(Mandatory)][string]$Server,
    [Parameter(Mandatory)][string]$LiveKit,
    [int]$Seconds = 10
)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:TEMP "hv-smoke-$PID"
New-Item -ItemType Directory -Force $dir | Out-Null
# Ports of its own: not the owner's server, and not a test copy's.
$config = @{ name = "smoke"; api_port = 27350; rtc_tcp_port = 27881; rtc_udp_port = 27882; livekit_port = 27880; upnp = $false; p2p = $true }
[IO.File]::WriteAllText((Join-Path $dir "server.json"), ($config | ConvertTo-Json))
$out = Join-Path $dir "out.log"
$err = Join-Path $dir "err.log"

$process = Start-Process -FilePath $Server -ArgumentList @("--data-dir", $dir, "--livekit-bin", $LiveKit) -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
$failure = $null
try {
    Start-Sleep -Seconds $Seconds
    if ($process.HasExited) {
        $failure = "the server died: " + ((@(Get-Content $out -ErrorAction SilentlyContinue) + @(Get-Content $err -ErrorAction SilentlyContinue) | Select-Object -Last 6) -join " ")
    } else {
        $socket = New-Object Net.Sockets.TcpClient
        try { $socket.Connect("127.0.0.1", 27350) } catch { $failure = "the server does not listen: $_" } finally { $socket.Dispose() }
    }
} finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    # Only the LiveKit this check started: the owner's own one runs from another folder.
    Get-Process livekit-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Resolve-Path $LiveKit).Path } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
if ($failure) { throw "Smoke test: $failure" }
Write-Host "Smoke test: the server stayed up for $Seconds s and listens."
