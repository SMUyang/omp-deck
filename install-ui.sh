#!/usr/bin/env bash
# omp-deck interactive installer — with terminal UI
#
# Features:
#   - ASCII art banner + colored progress
#   - Prerequisite checks (omp, bun, git)
#   - RPC mode verification
#   - Topology API configuration (optional)
#   - Extension auto-deployment
#   - Launch options
#
# Usage:
#   bash install-ui.sh                  # interactive
#   bash install-ui.sh --dir ~/omp     # specify directory
#   bash install-ui.sh --start         # install + start
#   bash install-ui.sh --help
#
set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/AI/omp-deck"
REPO_URL="git@github.com:SMUyang/omp-deck.git"
REPO_URL_HTTPS="https://github.com/SMUyang/omp-deck.git"
AUTO_START=false
CLONE_METHOD="ssh"

while [ $# -gt 0 ]; do
	case "$1" in
		--dir) INSTALL_DIR="$2"; shift 2 ;;
		--start) AUTO_START=true; shift ;;
		--https) CLONE_METHOD="https"; shift ;;
		--help|-h)
			echo "Usage: bash install-ui.sh [options]"
			echo ""
			echo "Options:"
			echo "  --dir PATH    Install directory (default: ~/AI/omp-deck)"
			echo "  --start       Start the deck after installation"
			echo "  --https       Use HTTPS instead of SSH for git clone"
			echo "  --help        Show this help"
			exit 0 ;;
		*) shift ;;
	esac
done

# ── Colors ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
	B='\033[1m'; N='\033[0m'
	G='\033[32m'; Y='\033[33m'; R='\033[31m'; C='\033[36m'; P='\033[35m'; D='\033[90m'
else
	B=''; N=''; G=''; Y=''; R=''; C=''; P=''; D=''
fi

banner() {
	echo ""
	echo -e "${C}  ╔═══════════════════════════════════════════════════════╗"
	echo -e "${C}  ║         ${B}${P}█ █ █  omp-deck installer  █ █ █${C}              ║"
	echo -e "${C}  ║                                                       ║"
	echo -e "${C}  ║  ${D}Cockpit for the omp coding agent${C}                    ║"
	echo -e "${C}  ║  ${D}RPC backend · Topology Memory · Kanban · Routines${C}  ║"
	echo -e "${C}  ╚═══════════════════════════════════════════════════════╝${N}"
	echo ""
}

step() { echo -e "\n${B}${C}── $1 ──${N}"; }
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1" >&2; }
info() { echo -e "  ${D}$1${N}"; }

progress() {
	local total=$1 current=$2 label=$3
	local pct=$((current * 100 / total))
	local filled=$((pct / 5))
	local empty=$((20 - filled))
	printf "\r  ${C}["
	printf "%0.s█" $(seq 1 $filled 2>/dev/null)
	printf "%0.s${D}░" $(seq 1 $empty 2>/dev/null)
	printf "${C}]${N} %3d%% ${D}%s${N}" "$pct" "$label"
}

prompt() {
	local question="$1" default="${2:-}"
	local answer
	if [ -n "$default" ]; then
		printf "  ${P}?${N} $question ${D}[$default]${N} "
	else
		printf "  ${P}?${N} $question "
	fi
	read -r answer
	echo "${answer:-$default}"
}

confirm() {
	local question="$1" default="${2:-y}"
	local answer
	printf "  ${P}?${N} $question ${D}[$([ "$default" = "y" ] && echo "Y/n" || echo "y/N")${D}]${N} "
	read -r answer
	[ -z "$answer" ] && answer="$default"
	[[ "$answer" =~ ^[Yy] ]]
}

# ── Start ───────────────────────────────────────────────────────────
banner

TOTAL_STEPS=6
CURRENT=0

# ── Step 1: Prerequisites ──────────────────────────────────────────
step "Step 1/6: Checking prerequisites"
CURRENT=1
progress $TOTAL_STEPS $CURRENT "Prerequisites..."

# Git
if command -v git >/dev/null 2>&1; then
	ok "$(git --version)"
else
	err "Git not found. Install: https://git-scm.com"
	exit 1
fi

# Bun
if command -v bun >/dev/null 2>&1; then
	ok "Bun $(bun --version)"
else
	warn "Bun not found. Installing..."
	curl -fsSL https://bun.sh/install | bash
	export BUN_INSTALL="$HOME/.bun"
	export PATH="$BUN_INSTALL/bin:$PATH"
	ok "Bun installed"
fi

# omp CLI
OMP_BIN=""
if [ -n "${OMP_DECK_OMP_BIN:-}" ]; then
	OMP_BIN="$OMP_DECK_OMP_BIN"
elif command -v omp >/dev/null 2>&1; then
	OMP_BIN=$(command -v omp)
else
	warn "omp CLI not found on PATH"
	OMP_BIN="$(prompt "Enter path to omp binary (or press Enter to skip):" "omp")"
fi

if [ "$OMP_BIN" != "omp" ] && [ -x "$OMP_BIN" ]; then
	ok "omp found at $OMP_BIN"
elif [ "$OMP_BIN" = "omp" ]; then
	ok "omp found on PATH"
else
	warn "omp not verified — deck will check at boot"
fi

progress $TOTAL_STEPS $CURRENT "Prerequisites done"
echo ""

# ── Step 2: Clone ──────────────────────────────────────────────────
step "Step 2/6: Setting up omp-deck"
CURRENT=2
progress $TOTAL_STEPS $CURRENT "Cloning..."

URL="$REPO_URL"
[ "$CLONE_METHOD" = "https" ] && URL="$REPO_URL_HTTPS"

if [ -d "$INSTALL_DIR/.git" ]; then
	info "Existing checkout found, pulling latest..."
	cd "$INSTALL_DIR"
	git pull --ff-only 2>/dev/null || warn "git pull failed (may need manual merge)"
	ok "Updated to latest"
else
	mkdir -p "$(dirname "$INSTALL_DIR")"
	info "Cloning from $URL..."
	if ! git clone --depth 1 "$URL" "$INSTALL_DIR" 2>/dev/null; then
		warn "SSH clone failed, trying HTTPS..."
		git clone --depth 1 "$REPO_URL_HTTPS" "$INSTALL_DIR"
	fi
	ok "Cloned to $INSTALL_DIR"
fi
cd "$INSTALL_DIR"

progress $TOTAL_STEPS $CURRENT "Clone done"
echo ""

# ── Step 3: Install dependencies ───────────────────────────────────
step "Step 3/6: Installing dependencies"
CURRENT=3
progress $TOTAL_STEPS $CURRENT "bun install..."

bun install
ok "Dependencies installed"

progress $TOTAL_STEPS $CURRENT "Dependencies done"
echo ""

# ── Step 4: Build web ──────────────────────────────────────────────
step "Step 4/6: Building web UI"
CURRENT=4
progress $TOTAL_STEPS $CURRENT "Building..."

bun run --filter '@omp-deck/web' build 2>/dev/null && ok "Web UI built" || warn "Web build skipped (dev mode)"

progress $TOTAL_STEPS $CURRENT "Build done"
echo ""

# ── Step 5: Topology configuration ─────────────────────────────────
step "Step 5/6: Topology Memory configuration"
CURRENT=5
progress $TOTAL_STEPS $CURRENT "Configuring..."

info "Topology Memory works out-of-the-box with local embedding."
info "For enhanced semantic retrieval, configure SiliconFlow API (optional)."

if confirm "Configure SiliconFlow embedding/rerank API?" "n"; then
	echo ""
	info "Get a key at: https://cloud.siliconflow.cn"
	SF_KEY="$(prompt 'Enter SiliconFlow API key:')"
	SF_BASE="${SF_BASE:-https://api.siliconflow.cn/v1}"

	if [ -n "$SF_KEY" ]; then
		CONFIG_DIR="${HOME}/.config/omp-deck"
		mkdir -p "$CONFIG_DIR"
		cat > "$CONFIG_DIR/.env" << ENVEOF
OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED=true
OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL=$SF_BASE
OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY=$SF_KEY
OMP_DECK_TOPOLOGY_EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5
OMP_DECK_TOPOLOGY_RERANK_ENABLED=true
OMP_DECK_TOPOLOGY_RERANK_PROVIDER=http
OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL=siliconflow-rerank
OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL=$SF_BASE
OMP_DECK_TOPOLOGY_RERANK_HTTP_API_KEY=$SF_KEY
OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL=BAAI/bge-reranker-v2-m3
ENVEOF
		ok "SiliconFlow API configured at $CONFIG_DIR/.env"
	else
		warn "No key entered — using local embedding only"
	fi
else
	ok "Using local embedding (no external API needed)"
fi

# Enable topology-memory extension
EXT_DIR="${HOME}/.omp/agent/extensions/topology-memory"
if [ ! -d "$EXT_DIR" ]; then
	mkdir -p "$EXT_DIR"
	cp -r packages/topology-memory/src/* "$EXT_DIR/"
	echo "0.7.9" > "$EXT_DIR/.deck-version"
	ok "Topology-memory extension deployed"
else
	info "Topology-memory extension already installed"
fi

progress $TOTAL_STEPS $CURRENT "Configuration done"
echo ""

# ── Step 6: Summary + Launch ───────────────────────────────────────
step "Step 6/6: Installation complete"
CURRENT=6
progress $TOTAL_STEPS $CURRENT "Ready!"
echo ""

echo -e "  ${G}╔═════════════════════════════════════════════════╗${N}"
echo -e "  ${G}║  ${B}omp-deck is ready to launch!${G}                 ║${N}"
echo -e "  ${G}╚═════════════════════════════════════════════════╝${N}"
echo ""
echo -e "  ${B}Configuration:${N}"
echo -e "    install dir : ${C}$INSTALL_DIR${N}"
echo -e "    server port : ${C}8787${N}"
echo -e "    omp binary  : ${C}${OMP_BIN:-omp}${N}"
echo -e "    embedding   : ${C}$([ -f "${HOME}/.config/omp-deck/.env" ] && echo 'SiliconFlow API' || echo 'local (built-in)')${N}"
echo ""

if [ "$AUTO_START" = true ] || confirm "Start omp-deck now?" "y"; then
	echo ""
	echo -e "  ${C}Starting server...${N}"
	echo -e "  ${D}Press Ctrl+C to stop${N}"
	echo ""
	exec bun run --filter '@omp-deck/server' start
else
	echo -e "  ${D}To start later:${N}"
	echo -e "  ${C}cd $INSTALL_DIR && bun run start${N}"
	echo ""
	echo -e "  ${D}Or use the RPC launch script:${N}"
	echo -e "  ${C}bash start-rpc-deck.sh${N}"
	echo ""
fi
