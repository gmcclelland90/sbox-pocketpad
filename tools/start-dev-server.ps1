# Starts a PocketPad server for local development on your network (plain http).
#
#   powershell -ExecutionPolicy Bypass -File tools\start-dev-server.ps1 [-Port 8080] [-MaxPlayers 100] [-Theme paper]
#
# - Installs the server's dependencies on first run.
# - Stops early with a clear message if the port is already taken.
# - Works out this PC's LAN address so phones get a link they can open (PUBLIC_URL).
# - Phones join at http://<LAN IP>:<port>; your s&box game connects to http://localhost:<port>
#   (s&box only allows loopback on ports 80/443/8080/8443, and no raw IPs).
# Any PUBLIC_URL / MAX_PLAYERS / HOST_KEYS / ... already set in your environment wins over the defaults here.
# Some mobile browsers (e.g. Edge) force https and can't open a plain http LAN address: type the http:// prefix,
# turn off the browser's automatic https upgrade, or use Chrome. Ctrl+C stops the server.
param(
    [int]$Port = 8080,
    [int]$MaxPlayers = 100,
    [string]$Theme = ""
)
$ErrorActionPreference = "Stop"

$serverDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\server")).Path

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $owner = Get-Process -Id ($busy | Select-Object -First 1).OwningProcess -ErrorAction SilentlyContinue
    throw "Port $Port is already in use by $($owner.ProcessName) (pid $($owner.Id)). Stop it first (another PocketPad server?), or pass -Port."
}

if (-not (Test-Path -LiteralPath (Join-Path $serverDir "node_modules"))) {
    Write-Host "Installing server dependencies..."
    Push-Location -LiteralPath $serverDir
    try { & npm.cmd ci --no-audit --no-fund } finally { Pop-Location }
}

if (-not $env:PUBLIC_URL) {
    $lan = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
        ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
    if (-not $lan) { $lan = "localhost" }
    $env:PUBLIC_URL = "http://${lan}:$Port"
}
$env:PORT = "$Port"
if (-not $env:MAX_PLAYERS) { $env:MAX_PLAYERS = "$MaxPlayers" }
if ($Theme -and -not $env:DEFAULT_THEME) { $env:DEFAULT_THEME = $Theme }

Write-Host ""
Write-Host "  Phones join at:   $($env:PUBLIC_URL)" -ForegroundColor Green
Write-Host "  Game connects to: http://localhost:$Port"
Write-Host "  Max phones/room:  $($env:MAX_PLAYERS)"
Write-Host "  Ctrl+C to stop."
Write-Host ""

Push-Location -LiteralPath $serverDir
try { & node src/index.js } finally { Pop-Location }
