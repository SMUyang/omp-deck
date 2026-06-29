#Requires -Version 5.1
# start-rpc-deck.ps1 - Windows launcher for omp-deck with external omp RPC backend.
# ASCII-only for Windows PowerShell 5.1 compatibility.
#
# Usage:
#   .\start-rpc-deck.ps1              foreground, Ctrl+C to stop
#   .\start-rpc-deck.ps1 start        background, opens browser
#   .\start-rpc-deck.ps1 stop         stop background instance
#   .\start-rpc-deck.ps1 status       check if running

[CmdletBinding()]
param(
  [ValidateSet("foreground", "start", "stop", "status")]
  [string]$Command = "foreground"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$LogDir = Join-Path $Root ".logs"
$PidFile = Join-Path $LogDir "rpc-deck.pid"
$LogFile = Join-Path $LogDir "rpc-deck.log"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Write-Info($Text) { Write-Output $Text }

function Resolve-OmpBin {
  if ($env:OMP_DECK_OMP_BIN) { return $env:OMP_DECK_OMP_BIN }
  $cmd = Get-Command omp -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "omp not found on PATH. Install it with: bun add -g @oh-my-pi/pi-coding-agent"
  }
  return $cmd.Source
}

function Ensure-Bun {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) {
    throw "bun not found on PATH. Install with: powershell -c \"irm bun.sh/install.ps1 | iex\""
  }
}

function Ensure-Dependencies {
  $viteCmd = Join-Path $Root "apps\web\node_modules\.bin\vite.cmd"
  $rootModules = Join-Path $Root "node_modules"
  if ((Test-Path $viteCmd) -and (Test-Path $rootModules)) { return }
  Write-Info "Installing dependencies with bun install..."
  & bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
}

function Ensure-WebBuild {
  $index = Join-Path $Root "apps\web\dist\index.html"
  if (Test-Path $index) { return }
  Write-Info "Building web frontend..."
  & bun run --filter '@omp-deck/web' build
  if ($LASTEXITCODE -ne 0) { throw "web build failed" }
}

function Set-RpcEnvironment {
  Ensure-Bun
  $ompBin = Resolve-OmpBin
  $env:OMP_DECK_AGENT_BACKEND = "rpc"
  $env:OMP_DECK_OMP_BIN = $ompBin
  if (-not $env:OMP_DECK_PORT) { $env:OMP_DECK_PORT = "8787" }
  if (-not $env:OMP_DECK_WEB_PORT) { $env:OMP_DECK_WEB_PORT = "5173" }
  $env:NO_COLOR = "1"

  Write-Info "+-- RPC Backend Configuration ------------------------+"
  Write-Info "|  omp binary : $env:OMP_DECK_OMP_BIN"
  Write-Info "|  server port: $env:OMP_DECK_PORT"
  Write-Info "|  web port   : $env:OMP_DECK_WEB_PORT"
  Write-Info "|  backend    : $env:OMP_DECK_AGENT_BACKEND"
  Write-Info "+------------------------------------------------------+"
}

function Stop-Deck {
  if (-not (Test-Path $PidFile)) {
    Write-Info "not running"
    return
  }
  $pidText = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidText -match '^\d+$') {
    $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($proc) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Write-Info "stopped omp-deck RPC server (PID $($proc.Id))"
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-DeckStatus {
  if (-not (Test-Path $PidFile)) {
    Write-Info "not running"
    return
  }
  $pidText = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidText -match '^\d+$') {
    $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Info "running (PID $($proc.Id)). Logs: $LogFile"
      return
    }
  }
  Write-Info "not running"
}

switch ($Command) {
  "stop" {
    Stop-Deck
    exit 0
  }
  "status" {
    Get-DeckStatus
    exit 0
  }
  "start" {
    Set-RpcEnvironment
    Ensure-Dependencies
    Ensure-WebBuild

    if (Test-Path $PidFile) {
      $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($oldPid -match '^\d+$' -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
        Write-Info "already running (PID $oldPid). Logs: $LogFile"
        exit 0
      }
    }

    $runFile = Join-Path $LogDir "rpc-deck-run.ps1"
    $rootEsc = $Root.Replace("'", "''")
    $logEsc = $LogFile.Replace("'", "''")
    $ompEsc = $env:OMP_DECK_OMP_BIN.Replace("'", "''")
    $runScript = @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath '$rootEsc'
`$env:OMP_DECK_AGENT_BACKEND = 'rpc'
`$env:OMP_DECK_OMP_BIN = '$ompEsc'
`$env:OMP_DECK_PORT = '$env:OMP_DECK_PORT'
`$env:OMP_DECK_WEB_PORT = '$env:OMP_DECK_WEB_PORT'
`$env:NO_COLOR = '1'
`$env:NODE_ENV = 'production'
bun run start *>> '$logEsc'
"@
    Set-Content -Path $runFile -Value $runScript -Encoding UTF8

    $proc = Start-Process -FilePath "powershell.exe" `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$runFile`"" `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -PassThru
    $proc.Id | Out-File -FilePath $PidFile -Encoding ascii
    Write-Info "started omp-deck RPC server (PID $($proc.Id)). Logs: $LogFile"
    Start-Sleep -Seconds 3
    Start-Process "http://127.0.0.1:$env:OMP_DECK_PORT"
    exit 0
  }
  default {
    Set-RpcEnvironment
    Ensure-Dependencies
    Ensure-WebBuild
    $env:NODE_ENV = "production"
    & bun run start
  }
}
