#!/usr/bin/env bash
# install-rpc-deck.sh — One-shot installer for omp-deck with external omp RPC backend.
#
# This script:
#   1. Checks prerequisites (Git, Bun, omp CLI)
#   2. Clones the fork (or uses an existing clone)
#   3. Runs bun install
#   4. Verifies omp --mode rpc works
#   5. Optionally starts the deck immediately
#
# Usage:
#   bash install-rpc-deck.sh                    # install + interactive start prompt
#   bash install-rpc-deck.sh --dir ~/AI/omp-deck  # specify install directory
#   bash install-rpc-deck.sh --start            # install + start immediately
#   bash install-rpc-deck.sh --help
#
# Environment overrides:
#   OMP_DECK_PORT        server port     (default 8787)
#   OMP_DECK_WEB_PORT    vite dev port   (default 5173)

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/AI/omp-deck"
REPO_URL="https://github.com/SMUyang/omp-deck.git"
AUTO_START=false
SKIP_TOPOLOGY=false
# ── Colors ──────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B='\033[1m'; G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[2m'; N='\033[0m'
else
  B=''; G=''; Y=''; R=''; D=''; N=''
fi

info()  { echo "${G}✓${N} $*"; }
warn()  { echo "${Y}⚠${N} $*"; }
err()   { echo "${R}✗${N} $*" >&2; }
step()  { echo ""; echo "${B}── $1 ──${N}"; }

# ── Parse args ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          INSTALL_DIR="$2"; shift 2 ;;
    --start)        AUTO_START=true; shift ;;
    --no-topology)  SKIP_TOPOLOGY=true; shift ;;
    --help|-h)
      cat <<USAGE
Usage: bash install-rpc-deck.sh [OPTIONS]

Options:
  --dir <path>      Install directory (default: ~/AI/omp-deck)
  --start           Start the deck immediately after install
  --no-topology     Skip interactive topology API configuration
  --help            Show this help

Environment:
  OMP_DECK_PORT     Server port (default 8787)
  OMP_DECK_WEB_PORT Vite dev port (default 5173)
USAGE
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ── 1. Check prerequisites ──────────────────────────────────────────────
step "Checking prerequisites"

# Git (auto-install if missing)
if ! command -v git >/dev/null 2>&1; then
  warn "Git is not installed. Attempting to install..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install git
      else
        info "Installing Homebrew first..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        if [ -f /opt/homebrew/bin/brew ]; then
          eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [ -f /usr/local/bin/brew ]; then
          eval "$(/usr/local/bin/brew shellenv)"
        fi
        brew install git
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq && sudo apt-get install -y git
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y git
      elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y git
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm git
      elif command -v apk >/dev/null 2>&1; then
        sudo apk add git
      else
        err "Could not detect package manager. Please install git manually."
        exit 1
      fi
      ;;
    *)
      err "Unsupported OS: $(uname -s). Please install git manually."
      exit 1
      ;;
  esac
  if ! command -v git >/dev/null 2>&1; then
    err "Git installation failed. Please install git manually."
    exit 1
  fi
fi
info "$(git --version) found"

# Bun
if ! command -v bun >/dev/null 2>&1; then
  err "Bun is not installed."
  echo "  Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
BUN_VER="$(bun --version)"
info "Bun $BUN_VER found"

# omp CLI
OMP_BIN=""
if [ -n "${OMP_DECK_OMP_BIN:-}" ]; then
  OMP_BIN="$OMP_DECK_OMP_BIN"
elif command -v omp >/dev/null 2>&1; then
  OMP_BIN="$(command -v omp)"
  # Resolve to absolute, following symlinks
  OMP_BIN="$(readlink -f "$OMP_BIN" 2>/dev/null || realpath "$OMP_BIN" 2>/dev/null || echo "$OMP_BIN")"
fi

if [ -z "$OMP_BIN" ]; then
  warn "omp CLI not found on PATH."
  echo "  The deck can still run in in-process mode (embedded SDK)."
  echo "  To use the RPC backend, install omp first:"
  echo "    bun add -g @oh-my-pi/pi-coding-agent"
  echo ""
  OMP_BIN=""
else
  OMP_VER="$("$OMP_BIN" --version 2>&1 | head -1)"
  info "omp $OMP_VER found at $OMP_BIN"
fi

# ── 2. Clone or update repo ─────────────────────────────────────────────
step "Setting up omp-deck"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing clone found at $INSTALL_DIR — pulling latest"
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || warn "git pull failed, continuing with existing state"
else
  info "Cloning $REPO_URL → $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── 3. Install dependencies ────────────────────────────────────────────
step "Installing dependencies"
bun install
info "Dependencies installed"

# ── 3b. Configure topology APIs ─────────────────────────────────────────
configure_topology() {
  step "Configuring topology APIs"

  cat <<'INTRO'

The deck's session-context topology system uses up to three APIs:

  1. SiliconFlow — provides both embedding (BAAI/bge-large-zh-v1.5)
     and rerank (BAAI/bge-reranker-v2-m3). One API key covers both.
  2. Extraction — a fast LLM for topology node extraction
     (DeepSeek, SiliconFlow, or any OpenAI-compatible endpoint).

All optional. You can configure or change them later via
Settings → Env in the deck UI.
INTRO

  if [ "$SKIP_TOPOLOGY" = true ]; then
    warn "Skipping topology configuration (--no-topology)."
    echo "  Configure later via the deck UI: Settings → Env"
    return 0
  fi
  if [ ! -t 0 ]; then
    warn "Non-interactive terminal — skipping topology configuration."
    echo "  Configure later via the deck UI: Settings → Env"
    return 0
  fi

  local env_file="$INSTALL_DIR/.env"
  local topo_tmp
  topo_tmp="$(mktemp)"

  # ── SiliconFlow (embedding + rerank) ──
  echo ""
  echo "${B}SiliconFlow${N} — embedding + rerank (shared API key)"
  echo "  Get a key at https://cloud.siliconflow.cn"
  local sf_key=""
  printf "  API key (blank = skip both): "
  IFS= read -rs sf_key
  echo ""

  if [ -n "$sf_key" ]; then
    cat >> "$topo_tmp" <<EOF
OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED=true
OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY=$sf_key
OMP_DECK_TOPOLOGY_EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5
OMP_DECK_TOPOLOGY_RERANK_ENABLED=true
OMP_DECK_TOPOLOGY_RERANK_PROVIDER=http
OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL=siliconflow-rerank
OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL=https://api.siliconflow.cn/v1
OMP_DECK_TOPOLOGY_RERANK_HTTP_API_KEY=$sf_key
OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL=BAAI/bge-reranker-v2-m3
EOF
    info "Embedding + Rerank enabled (SiliconFlow)"
  else
    warn "Skipping embedding + rerank."
  fi

  # ── Extraction ──
  echo ""
  echo "${B}Extraction${N} — fast model for topology node extraction"
  local ext_ans=""
  printf "  Configure? [y/N] "
  IFS= read -r ext_ans
  case "$ext_ans" in
    [Yy]*)
      local ext_url ext_key ext_model
      printf "  Base URL [https://api.deepseek.com]: "
      IFS= read -r ext_url
      ext_url="${ext_url:-https://api.deepseek.com}"
      printf "  API Key: "
      IFS= read -rs ext_key
      echo ""
      printf "  Model [deepseek-chat]: "
      IFS= read -r ext_model
      ext_model="${ext_model:-deepseek-chat}"
      if [ -n "$ext_key" ]; then
        cat >> "$topo_tmp" <<EOF
OMP_DECK_TOPOLOGY_EXTRACTION_MODE=fast_model
OMP_DECK_TOPOLOGY_EXTRACTION_BASE_URL=$ext_url
OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY=$ext_key
OMP_DECK_TOPOLOGY_EXTRACTION_MODEL=$ext_model
EOF
        info "Extraction enabled ($ext_model @ $ext_url)"
      else
        warn "No extraction API key — skipping."
      fi
      ;;
    *)
      warn "Skipping extraction."
      ;;
  esac

  # ── Write to .env ──
  if [ -s "$topo_tmp" ]; then
    if [ -f "$env_file" ]; then
      grep -v '^OMP_DECK_TOPOLOGY_' "$env_file" > "${env_file}.tmp" || true
    else
      : > "${env_file}.tmp"
    fi
    {
      echo ""
      echo "# ─── Topology APIs (configured by installer) ───────────────────────"
      cat "$topo_tmp"
    } >> "${env_file}.tmp"
    mv "${env_file}.tmp" "$env_file"
    info "Topology config written to .env"
  else
    warn "No topology APIs configured."
    echo "  Set them later via the deck UI: Settings → Env"
  fi

  rm -f "$topo_tmp"
}

configure_topology

# ── 4. Verify omp RPC mode (if omp is available) ───────────────────────
if [ -n "$OMP_BIN" ]; then
  step "Verifying omp --mode rpc"
  # Quick probe: send get_available_models and check we get a response
  echo '{"id":"probe","type":"get_available_models"}' | \
    timeout 15 "$OMP_BIN" --mode rpc 2>/dev/null | \
    head -5 | \
    grep -q '"type":"response"' && \
    info "omp --mode rpc responds correctly" || \
    warn "omp --mode rpc probe did not return a clean response. The deck will still attempt to use it."
fi

# ── 5. Summary + optional start ─────────────────────────────────────────
step "Installation complete"

DECK_PORT="${OMP_DECK_PORT:-8787}"
WEB_PORT="${OMP_DECK_WEB_PORT:-5173}"

echo ""
echo "${B}Configuration:${N}"
if [ -n "$OMP_BIN" ]; then
  echo "  omp binary  : $OMP_BIN"
  echo "  backend     : rpc (external omp)"
else
  echo "  omp binary  : (not found — will use in-process embedded SDK)"
  echo "  backend     : in-process (default)"
fi
echo "  install dir : $INSTALL_DIR"
echo "  server port : $DECK_PORT"
echo "  web port    : $WEB_PORT"
echo ""

if [ "$AUTO_START" = true ]; then
  echo "Starting omp-deck..."
  if [ -n "$OMP_BIN" ]; then
    cd "$INSTALL_DIR"
    exec env \
      OMP_DECK_AGENT_BACKEND=rpc \
      OMP_DECK_OMP_BIN="$OMP_BIN" \
      OMP_DECK_PORT="$DECK_PORT" \
      OMP_DECK_WEB_PORT="$WEB_PORT" \
      NO_COLOR=1 \
      bun run dev
  else
    cd "$INSTALL_DIR"
    exec env \
      OMP_DECK_PORT="$DECK_PORT" \
      OMP_DECK_WEB_PORT="$WEB_PORT" \
      NO_COLOR=1 \
      bun run dev
  fi
else
  echo "${B}To start with RPC backend:${N}"
  if [ -n "$OMP_BIN" ]; then
    echo "  cd $INSTALL_DIR"
    echo "  OMP_DECK_AGENT_BACKEND=rpc OMP_DECK_OMP_BIN=$OMP_BIN bun run dev"
    echo ""
    echo "  Or use the launcher:"
    echo "  bash start-rpc-deck.sh"
  else
    echo "  cd $INSTALL_DIR"
    echo "  bun run dev"
    echo ""
    warn "Install omp CLI first to use the RPC backend:"
    echo "  bun add -g @oh-my-pi/pi-coding-agent"
  fi
  echo ""
  echo "Then open http://127.0.0.1:$WEB_PORT in your browser."
fi
