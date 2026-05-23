# Start the omp-deck server and web dev server, then open the deck.
# ASCII only per PS 5.1 .ps1 parse rules.
$ErrorActionPreference = "Stop"

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverScript = Join-Path $PSScriptRoot "start-deck-server.ps1"
$webScript = Join-Path $PSScriptRoot "start-deck-web.ps1"
$deckUrl = "http://127.0.0.1:5173/"

if (-not (Get-Command "bun" -ErrorAction SilentlyContinue)) {
    throw "Bun was not found on PATH. Install Bun, then run 'bun install' in $rootDir."
}

if (-not (Test-Path (Join-Path $rootDir "node_modules"))) {
    throw "Dependencies are missing. Run 'bun install' in $rootDir first."
}

Write-Output "Starting omp-deck background server..."
& $serverScript

Write-Output ""
Write-Output "Starting omp-deck web server..."
& $webScript

Write-Output ""
Write-Output ("Opening " + $deckUrl)
Start-Process $deckUrl

Write-Output ""
Write-Output "Ready."
Write-Output ("Deck: " + $deckUrl)
Write-Output ("API health: http://127.0.0.1:8787/api/health")
