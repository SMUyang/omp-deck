#Requires -Version 5.1
# install-rpc-deck.ps1 — Windows installer for omp-deck with external omp RPC backend.
#
# Usage (PowerShell):
#   .\install-rpc-deck.ps1                    # install only
#   .\install-rpc-deck.ps1 -Start             # install + start immediately
#   .\install-rpc-deck.ps1 -InstallDir C:\code\omp-deck
#   .\install-rpc-deck.ps1 -Help
#
# Usage (CMD):
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-rpc-deck.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-rpc-deck.ps1 -Start

[CmdletBinding()]
param(
  [string]$InstallDir = "$env:USERPROFILE\AI\omp-deck",
  [switch]$Start,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
  Write-Output "Usage: .\install-rpc-deck.ps1 [OPTIONS]"
  Write-Output ""
  Write-Output "Options:"
  Write-Output "  -InstallDir <path>  Install directory (default: %USERPROFILE%\AI\omp-deck)"
  Write-Output "  -Start              Start the deck immediately after install"
  Write-Output "  -Help               Show this help"
  Write-Output ""
  Write-Output "Environment:"
  Write-Output "  OMP_DECK_PORT       Server port (default 8787)"
  Write-Output "  OMP_DECK_WEB_PORT   Vite dev port (default 5173)"
  exit 0
}

$RepoUrl = "https://github.com/SMUyang/omp-deck.git"
$DeckPort = if ($env:OMP_DECK_PORT) { $env:OMP_DECK_PORT } else { "8787" }
$WebPort = if ($env:OMP_DECK_WEB_PORT) { $env:OMP_DECK_WEB_PORT } else { "5173" }

function Write-Step($msg) { Write-Output ""; Write-Output "-- $msg --" }
function Write-Ok($msg)   { Write-Output "[OK] $msg" }
function Write-Warn2($msg){ Write-Output "[!]  $msg" }
function Write-Err2($msg) { Write-Output "[X]  $msg" }

# ── 1. Check prerequisites ──────────────────────────────────────────────
Write-Step "Checking prerequisites"

# Bun
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
  Write-Err2 "Bun is not installed."
  Write-Output "  Install: powershell -c `"irm bun.sh/install.ps1 | iex`""
  exit 1
}
$bunVer = & bun --version 2>$null
Write-Ok "Bun $bunVer found"

# omp CLI
$OmpBin = $env:OMP_DECK_OMP_BIN
if (-not $OmpBin) {
  $ompCmd = Get-Command omp -ErrorAction SilentlyContinue
  if ($ompCmd) {
    $OmpBin = $ompCmd.Source
    # Resolve symlinks
    try { $OmpBin = (Get-Item $OmpBin).Target } catch {}
    if (-not $OmpBin) { $OmpBin = $ompCmd.Source }
  }
}

if (-not $OmpBin) {
  Write-Warn2 "omp CLI not found on PATH."
  Write-Output "  The deck can still run in in-process mode (embedded SDK)."
  Write-Output "  To use the RPC backend, install omp first:"
  Write-Output "    bun add -g @oh-my-pi/pi-coding-agent"
} else {
  $ompVer = & $OmpBin --version 2>&1 | Select-Object -First 1
  Write-Ok "omp $ompVer found at $OmpBin"
}

# Git
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Write-Err2 "Git is not installed."
  Write-Output "  Install: winget install Git.Git"
  exit 1
}
Write-Ok "Git found"

# ── 2. Clone or update repo ─────────────────────────────────────────────
Write-Step "Setting up omp-deck"

if (Test-Path "$InstallDir\.git") {
  Write-Ok "Existing clone found at $InstallDir — pulling latest"
  Push-Location $InstallDir
  try { git pull --ff-only origin main 2>$null } catch { Write-Warn2 "git pull failed, continuing" }
  Pop-Location
} else {
  Write-Output "Cloning $RepoUrl -> $InstallDir"
  git clone $RepoUrl $InstallDir
}

# ── 3. Install dependencies ────────────────────────────────────────────
Write-Step "Installing dependencies"
Push-Location $InstallDir
& bun install
Pop-Location
Write-Ok "Dependencies installed"

# ── 4. Summary ──────────────────────────────────────────────────────────
Write-Step "Installation complete"

Write-Output ""
Write-Output "Configuration:"
if ($OmpBin) {
  Write-Output "  omp binary  : $OmpBin"
  Write-Output "  backend     : rpc (external omp)"
} else {
  Write-Output "  omp binary  : (not found -- will use in-process embedded SDK)"
  Write-Output "  backend     : in-process (default)"
}
Write-Output "  install dir : $InstallDir"
Write-Output "  server port : $DeckPort"
Write-Output "  web port    : $WebPort"
Write-Output ""

if ($Start) {
  Write-Output "Starting omp-deck..."
  Push-Location $InstallDir
  $env:NO_COLOR = "1"
  if ($OmpBin) {
    $env:OMP_DECK_AGENT_BACKEND = "rpc"
    $env:OMP_DECK_OMP_BIN = $OmpBin
  }
  $env:OMP_DECK_PORT = $DeckPort
  $env:OMP_DECK_WEB_PORT = $WebPort
  & bun run dev
  Pop-Location
} else {
  Write-Output "To start with RPC backend:"
  if ($OmpBin) {
    Write-Output "  cd $InstallDir"
    Write-Output "  `$env:OMP_DECK_AGENT_BACKEND='rpc'; `$env:OMP_DECK_OMP_BIN='$OmpBin'; bun run dev"
    Write-Output ""
    Write-Output "  Or use the CMD launcher:"
    Write-Output "  start-rpc-deck.cmd"
  } else {
    Write-Output "  cd $InstallDir"
    Write-Output "  bun run dev"
    Write-Output ""
    Write-Warn2 "Install omp CLI first to use the RPC backend:"
    Write-Output "  bun add -g @oh-my-pi/pi-coding-agent"
  }
  Write-Output ""
  Write-Output "Then open http://127.0.0.1:$WebPort in your browser."
}
