#!/usr/bin/env bash
# start-rpc-deck.sh — Launch omp-deck with external omp RPC backend.
#
# Instead of using the embedded @oh-my-pi/pi-coding-agent SDK, this script
# starts omp-deck in RPC mode so it talks to your globally installed `omp`
# binary via `omp --mode rpc`. This ensures the Web UI matches your terminal
# omp experience exactly (same model catalog, same session data).
# Auto-pulls latest code and dependencies before starting.
#
# Usage:
#   bash start-rpc-deck.sh              # foreground (Ctrl+C to stop)
#   bash start-rpc-deck.sh start        # background, opens browser
#   bash start-rpc-deck.sh stop         # stop background instance
#   bash start-rpc-deck.sh status       # check if running
#
# Environment overrides:
#   OMP_DECK_PORT          server port      (default 8787)
#   OMP_DECK_WEB_PORT      vite dev port    (default 5173)
#   OMP_DECK_OMP_BIN       omp binary path  (default: auto-detect absolute path)
#   OMP_DECK_DEFAULT_CWD   default workspace (default: $HOME)

set -euo pipefail
cd "$(dirname "$0")"

LOG_DIR=".logs"
PID_FILE="$LOG_DIR/rpc-deck.pid"
LOG_FILE="$LOG_DIR/rpc-deck.log"

# ── Resolve omp binary to an absolute path ──────────────────────────────
resolve_omp_bin() {
  if [ -n "${OMP_DECK_OMP_BIN:-}" ]; then
    echo "$OMP_DECK_OMP_BIN"
    return
  fi
  local bin
  bin="$(command -v omp 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    echo "ERROR: 'omp' not found on PATH." >&2
    echo "Install it with: bun add -g @oh-my-pi/pi-coding-agent" >&2
    echo "Or set OMP_DECK_OMP_BIN=/path/to/omp explicitly." >&2
    exit 1
  fi
  # Resolve symlinks and make absolute
  local resolved
  if resolved="$(readlink -f "$bin" 2>/dev/null || realpath "$bin" 2>/dev/null || true)"; then
    [ -n "$resolved" ] && bin="$resolved"
  fi
  echo "$bin"
}

# ── Build env for the dev server ────────────────────────────────────────
build_env() {
  local omp_bin
  omp_bin="$(resolve_omp_bin)"
  export OMP_DECK_AGENT_BACKEND="rpc"
  export OMP_DECK_OMP_BIN="$omp_bin"
  export OMP_DECK_PORT="${OMP_DECK_PORT:-8787}"
  export OMP_DECK_WEB_PORT="${OMP_DECK_WEB_PORT:-5173}"
  export NO_COLOR="${NO_COLOR:-1}"

  echo "┌─ RPC Backend Configuration ─────────────────────────────┐"
  echo "│  omp binary : $OMP_DECK_OMP_BIN"
  echo "│  server port: $OMP_DECK_PORT"
  echo "│  web port   : $OMP_DECK_WEB_PORT"
  echo "│  backend    : $OMP_DECK_AGENT_BACKEND"
  echo "└──────────────────────────────────────────────────────────┘"
}

# ── Verify omp version ──────────────────────────────────────────────────
check_omp() {
  local omp_bin
  omp_bin="$(resolve_omp_bin)"
  if ! "$omp_bin" --version >/dev/null 2>&1; then
    echo "WARNING: '$omp_bin --version' failed — the binary may not be runnable." >&2
  else
    local ver
    ver="$("$omp_bin" --version 2>&1 | head -1)"
    echo "  omp version: $ver"
  fi
}

# ── Pull latest updates before starting ─────────────────────────────────
self_update() {
  if [ ! -d ".git" ]; then
    return
  fi
  echo "  pulling latest updates..."
  if git pull --ff-only origin main 2>/dev/null; then
    bun install --frozen-lockfile > "$LOG_DIR/install.log" 2>&1 || true
  else
    echo "  WARNING: git pull failed, continuing with current state"
  fi
}

mkdir -p "$LOG_DIR"

case "${1:-foreground}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "omp-deck (RPC) already running (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
      exit 0
    fi
    build_env
    check_omp
    self_update
    nohup env \
      OMP_DECK_AGENT_BACKEND="$OMP_DECK_AGENT_BACKEND" \
      OMP_DECK_OMP_BIN="$OMP_DECK_OMP_BIN" \
      OMP_DECK_PORT="$OMP_DECK_PORT" \
      OMP_DECK_WEB_PORT="$OMP_DECK_WEB_PORT" \
      NO_COLOR="$NO_COLOR" \
      bun run dev > "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    echo "omp-deck (RPC) started (PID $PID). Logs: $LOG_FILE"
    sleep 5
    DECK_URL="http://127.0.0.1:${OMP_DECK_WEB_PORT}"
    if command -v open >/dev/null 2>&1; then open "$DECK_URL"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$DECK_URL"
    else echo "Open $DECK_URL in your browser."
    fi
    ;;

  stop)
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      if kill -0 "$PID" 2>/dev/null; then
        kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
        sleep 1
        if kill -0 "$PID" 2>/dev/null; then
          kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
        fi
        echo "stopped omp-deck (RPC) (PID $PID)"
      fi
      rm -f "$PID_FILE"
    else
      echo "no PID file at $PID_FILE — nothing to stop"
    fi
    ;;

  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
    else
      echo "not running"
    fi
    ;;

  foreground|"")
    build_env
    check_omp
    self_update
    exec bun run dev
    ;;

  *)
    cat <<USAGE
Usage: $0 [start|stop|status|foreground]

  (no arg)     foreground run, same as 'bun run dev' with RPC backend
  start        background, writes PID + logs to $LOG_DIR/, opens browser
  stop         terminate the background run started via 'start'
  status       check whether a background run is alive

Environment overrides:
  OMP_DECK_PORT        server port       (default 8787)
  OMP_DECK_WEB_PORT    vite dev port     (default 5173)
  OMP_DECK_OMP_BIN     omp binary path   (default: auto-detect via PATH)
  OMP_DECK_DEFAULT_CWD default workspace (default: \$HOME)
USAGE
    exit 1
    ;;
esac
