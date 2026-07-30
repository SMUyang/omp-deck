#Requires -Version 5.1
# install-rpc-deck.ps1 - Windows installer for omp-deck with external omp RPC backend.
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
  [switch]$SkipTopology,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
  Write-Output "Usage: .\install-rpc-deck.ps1 [OPTIONS]"
  Write-Output ""
  Write-Output "Options:"
  Write-Output "  -InstallDir <path>  Install directory (default: %USERPROFILE%\AI\omp-deck)"
  Write-Output "  -Start              Start the deck immediately after install"
  Write-Output "  -SkipTopology       Skip interactive topology API configuration"
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

function Invoke-Checked($FilePath, $Arguments, $FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

# -- 1. Check prerequisites ------------------------------------------------
Write-Step "Checking prerequisites"

# Bun
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
  Write-Err2 "Bun is not installed."
  Write-Output '  Install: powershell -c "irm bun.sh/install.ps1 | iex"'
  exit 1
}
$bunVer = (& bun --version 2>&1 | Out-String).Trim()
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

# Git (auto-install if missing)
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Write-Warn2 "Git is not installed. Attempting to install..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install Git.Git --accept-package-agreements --accept-source-agreements
  } else {
    $choco = Get-Command choco -ErrorAction SilentlyContinue
    if ($choco) {
      & choco install git -y
    } else {
      Write-Err2 "Could not auto-install git. Please install manually: winget install Git.Git"
      exit 1
    }
  }
  # Refresh PATH so newly installed git is visible
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if (-not $gitCmd) {
    Write-Err2 "Git installed but not on PATH. Please reopen your terminal and run this script again."
    exit 1
  }
}
Write-Ok "Git found"

# -- 2. Clone or update repo ----------------------------------------------
Write-Step "Setting up omp-deck"

if (Test-Path "$InstallDir\.git") {
  Write-Ok "Existing clone found at $InstallDir - pulling latest"
  Push-Location $InstallDir
  try {
    & git pull --ff-only origin main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "git pull failed, continuing with existing state" }
  } finally {
    Pop-Location
  }
} else {
  Write-Output "Cloning $RepoUrl -> $InstallDir"
  Invoke-Checked "git" @("clone", $RepoUrl, $InstallDir) "git clone failed"
}

# -- 3. Install dependencies ----------------------------------------------
Write-Step "Installing dependencies"
Push-Location $InstallDir
try {
  Invoke-Checked "bun" @("install") "bun install failed"
} finally {
  Pop-Location
}
Write-Ok "Dependencies installed"

# -- 3b. Build web frontend ----------------------------------------------
Write-Step "Building web frontend"
Push-Location $InstallDir
try {
  Invoke-Checked "bun" @("run", "--filter", "@omp-deck/web", "build") "web build failed"
} finally {
  Pop-Location
}
Write-Ok "Web frontend built"

# -- 3c. Configure topology APIs -----------------------------------------
function Configure-Topology {
  Write-Step "Configuring topology APIs"

  Write-Output ""
  Write-Output "The deck's session-context topology system uses up to three APIs:"
  Write-Output ""
  Write-Output "  1. SiliconFlow - embedding (BAAI/bge-large-zh-v1.5)"
  Write-Output "     + rerank (BAAI/bge-reranker-v2-m3). One API key covers both."
  Write-Output "  2. Extraction - a fast LLM for topology node extraction"
  Write-Output "     (DeepSeek, SiliconFlow, or any OpenAI-compatible endpoint)."
  Write-Output ""
  Write-Output "All optional. Configure or change them later via"
  Write-Output "Settings -> Env in the deck UI."

  if ($SkipTopology) {
    Write-Warn2 "Skipping topology configuration (-SkipTopology)."
    Write-Output "  Configure later via the deck UI: Settings -> Env"
    return
  }

  $envFile = Join-Path $InstallDir ".env"
  $topoLines = [System.Collections.ArrayList]@()

  # -- SiliconFlow (embedding + rerank) --
  Write-Output ""
  Write-Output "SiliconFlow - embedding + rerank (shared API key)"
  Write-Output "  Get a key at https://cloud.siliconflow.cn"
  $sfKey = Read-Host "  API key (blank = skip both)"

  if ($sfKey) {
    [void]$topoLines.AddRange(@(
      "OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED=true",
      "OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1",
      "OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY=$sfKey",
      "OMP_DECK_TOPOLOGY_EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5",
      "OMP_DECK_TOPOLOGY_RERANK_ENABLED=true",
      "OMP_DECK_TOPOLOGY_RERANK_PROVIDER=http",
      "OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL=siliconflow-rerank",
      "OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL=https://api.siliconflow.cn/v1",
      "OMP_DECK_TOPOLOGY_RERANK_HTTP_API_KEY=$sfKey",
      "OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL=BAAI/bge-reranker-v2-m3"
    ))
    Write-Ok "Embedding + Rerank enabled (SiliconFlow)"
  } else {
    Write-Warn2 "Skipping embedding + rerank."
  }

  # -- Extraction --
  Write-Output ""
  Write-Output "Extraction - fast model for topology node extraction"
  $extAns = Read-Host "  Configure? [y/N]"
  if ($extAns -match '^[Yy]') {
    $extUrl = Read-Host "  Base URL [https://api.deepseek.com]"
    if (-not $extUrl) { $extUrl = "https://api.deepseek.com" }
    $extKey = Read-Host "  API Key"
    $extModel = Read-Host "  Model [deepseek-chat]"
    if (-not $extModel) { $extModel = "deepseek-chat" }
    if ($extKey) {
      [void]$topoLines.AddRange(@(
        "OMP_DECK_TOPOLOGY_EXTRACTION_MODE=fast_model",
        "OMP_DECK_TOPOLOGY_EXTRACTION_BASE_URL=$extUrl",
        "OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY=$extKey",
        "OMP_DECK_TOPOLOGY_EXTRACTION_MODEL=$extModel"
      ))
      Write-Ok "Extraction enabled ($extModel @ $extUrl)"
    } else {
      Write-Warn2 "No extraction API key - skipping."
    }
  } else {
    Write-Warn2 "Skipping extraction."
  }

  # -- Write to .env --
  if ($topoLines.Count -gt 0) {
    $existing = @()
    if (Test-Path $envFile) {
      $existing = @(Get-Content $envFile | Where-Object { $_ -notmatch '^OMP_DECK_TOPOLOGY_' })
    }
    $existing += ""
    $existing += "# --- Topology APIs (configured by installer) ---"
    $existing += $topoLines
    $existing | Set-Content $envFile -Encoding UTF8
    Write-Ok "Topology config written to $envFile"
  } else {
    Write-Warn2 "No topology APIs configured."
    Write-Output "  Set them later via the deck UI: Settings -> Env"
  }
}

Configure-Topology

# -- 4. Summary ------------------------------------------------------------
Write-Step "Installation complete"

Write-Output ""
Write-Output "Configuration:"
if ($OmpBin) {
  Write-Output "  omp binary  : $OmpBin"
  Write-Output "  backend     : rpc (external omp)"
} else {
  Write-Output "  omp binary  : (not found -- RPC launcher will ask you to install omp)"
  Write-Output "  backend     : rpc (requires external omp)"
}
Write-Output "  install dir : $InstallDir"
Write-Output "  server port : $DeckPort"
Write-Output "  web port    : $WebPort"
Write-Output ""

if ($Start) {
  Write-Output "Starting omp-deck with the RPC launcher..."
  if ($OmpBin) { $env:OMP_DECK_OMP_BIN = $OmpBin }
  $env:OMP_DECK_PORT = $DeckPort
  $env:OMP_DECK_WEB_PORT = $WebPort
  $launcher = Join-Path $InstallDir "start-rpc-deck.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher
} else {
  Write-Output "To start:"
  Write-Output "  cd $InstallDir"
  Write-Output "  .\start-rpc-deck.cmd"
  Write-Output ""
  Write-Output "Or from PowerShell:"
  Write-Output "  .\start-rpc-deck.ps1"
  if (-not $OmpBin) {
    Write-Output ""
    Write-Warn2 "Install omp CLI first to use the RPC backend:"
    Write-Output "  bun add -g @oh-my-pi/pi-coding-agent"
  }
  Write-Output ""
  Write-Output "Then open http://127.0.0.1:$DeckPort in your browser."
}
