#!/usr/bin/env bash
# omp-deck-daemon.sh — Cross-platform background daemon manager
#
# Keeps omp-deck server running in the background with NO terminal window.
# Auto-starts on login, auto-restarts on crash.
#
# Usage:
#   bash omp-deck-daemon.sh install     # Register as system service
#   bash omp-deck-daemon.sh uninstall   # Remove system service
#   bash omp-deck-daemon.sh start       # Start background server
#   bash omp-deck-daemon.sh stop        # Stop server
#   bash omp-deck-daemon.sh restart     # Restart server
#   bash omp-deck-daemon.sh status      # Check if running
#   bash omp-deck-daemon.sh logs        # Tail server logs
#   bash omp-deck-daemon.sh browser     # Open browser to the deck
#
set -euo pipefail

DECK_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ID="com.ompdeck.server"
PORT="${OMP_DECK_PORT:-8787}"
LOG_FILE="/tmp/omp-deck.log"
ERR_FILE="/tmp/omp-deck.err.log"

# ── Detect OS ───────────────────────────────────────────────────────
detect_os() {
	case "$(uname -s)" in
		Darwin) echo "macos" ;;
		Linux)  echo "linux" ;;
		MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
		*) echo "unknown" ;;
	esac
}

OS="$(detect_os)"

# ── Detect bun binary ───────────────────────────────────────────────
detect_bun() {
	local bun
	bun="$(command -v bun 2>/dev/null || true)"
	if [ -z "$bun" ]; then
		if [ -x "$HOME/.bun/bin/bun" ]; then
			bun="$HOME/.bun/bin/bun"
		elif [ -x "/opt/homebrew/bin/bun" ]; then
			bun="/opt/homebrew/bin/bun"
		elif [ -x "/usr/local/bin/bun" ]; then
			bun="/usr/local/bin/bun"
		fi
	fi
	if [ -z "$bun" ]; then
		echo "ERROR: bun not found" >&2
		exit 1
	fi
	echo "$bun"
}

BUN_BIN="$(detect_bun)"

# ── Colors ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
	G='\033[32m'; Y='\033[33m'; R='\033[31m'; C='\033[36m'; D='\033[90m'; N='\033[0m'
else
	G=''; Y=''; R=''; C=''; D=''; N=''
fi
ok()   { echo -e "  ${G}✓${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1" >&2; }
info() { echo -e "  ${D}$1${N}"; }

# ── Browser open command ────────────────────────────────────────────
open_browser() {
	case "$OS" in
		macos)   open "http://127.0.0.1:$PORT" 2>/dev/null || true ;;
		linux)   xdg-open "http://127.0.0.1:$PORT" 2>/dev/null || true ;;
		windows) cmd.exe /c start "http://127.0.0.1:$PORT" 2>/dev/null || true ;;
	esac
}

# ── Check if server is running ──────────────────────────────────────
is_running() {
	if command -v lsof >/dev/null 2>&1; then
		lsof -ti:"$PORT" >/dev/null 2>&1
	elif command -v curl >/dev/null 2>&1; then
		curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
	else
		return 1
	fi
}

wait_for_server() {
	for i in $(seq 1 30); do
		if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	return 1
}

# ════════════════════════════════════════════════════════════════════
# macOS: launchd
# ════════════════════════════════════════════════════════════════════

macos_plist() {
	local plist_dir="$HOME/Library/LaunchAgents"
	mkdir -p "$plist_dir"
	local plist_file="$plist_dir/$APP_ID.plist"

	cat > "$plist_file" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$APP_ID</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN_BIN</string>
		<string>run</string>
		<string>--filter</string>
		<string>@omp-deck/server</string>
		<string>start</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$DECK_DIR</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$LOG_FILE</string>
	<key>StandardErrorPath</key>
	<string>$ERR_FILE</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>NODE_ENV</key>
		<string>production</string>
	</dict>
</dict>
</plist>
PLIST
	echo "$plist_file"
}

macos_install() {
	local plist_file
	plist_file="$(macos_plist)"
	launchctl unload "$plist_file" 2>/dev/null || true
	launchctl load "$plist_file"
	ok "launchd service registered: $APP_ID"
	info "Auto-starts on login, auto-restarts on crash"
}

macos_uninstall() {
	local plist_file="$HOME/Library/LaunchAgents/$APP_ID.plist"
	launchctl unload "$plist_file" 2>/dev/null || true
	rm -f "$plist_file"
	ok "launchd service removed"
}

macos_start() {
	if is_running; then ok "Already running"; open_browser; return 0; fi
	launchctl start "$APP_ID" 2>/dev/null || {
		# Fallback: direct nohup if launchctl not available
		cd "$DECK_DIR"
		nohup "$BUN_BIN" run --filter '@omp-deck/server' start > "$LOG_FILE" 2> "$ERR_FILE" &
	}
	wait_for_server && ok "Server started on port $PORT" && open_browser
}

macos_stop() {
	launchctl stop "$APP_ID" 2>/dev/null || true
	# Also kill any direct process on the port
	if command -v lsof >/dev/null 2>&1; then
		local pid
		pid="$(lsof -ti:"$PORT" 2>/dev/null || true)"
		[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
	fi
	ok "Server stopped"
}

macos_status() {
	if is_running; then
		ok "Running on port $PORT"
		info "PID: $(lsof -ti:"$PORT" 2>/dev/null | head -1 || echo '?')"
	else
		err "Not running"
		return 1
	fi
}

# ════════════════════════════════════════════════════════════════════
# Linux: systemd --user
# ════════════════════════════════════════════════════════════════════

linux_service_file() {
	local svc_dir="$HOME/.config/systemd/user"
	mkdir -p "$svc_dir"
	local svc_file="$svc_dir/omp-deck.service"

	cat > "$svc_file" << SVC
[Unit]
Description=OMP Deck Server
After=network.target

[Service]
Type=simple
ExecStart=$BUN_BIN run --filter @omp-deck/server start
WorkingDirectory=$DECK_DIR
Restart=always
RestartSec=3
StandardOutput=append:$LOG_FILE
StandardError=append:$ERR_FILE
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
SVC
	echo "$svc_file"
}

linux_install() {
	linux_service_file >/dev/null
	systemctl --user daemon-reload
	systemctl --user enable omp-deck.service
	ok "systemd service registered"
	info "Auto-starts on login, auto-restarts on crash"
}

linux_uninstall() {
	systemctl --user stop omp-deck.service 2>/dev/null || true
	systemctl --user disable omp-deck.service 2>/dev/null || true
	rm -f "$HOME/.config/systemd/user/omp-deck.service"
	systemctl --user daemon-reload
	ok "systemd service removed"
}

linux_start() {
	if is_running; then ok "Already running"; open_browser; return 0; fi
	systemctl --user start omp-deck.service 2>/dev/null || {
		cd "$DECK_DIR"
		nohup "$BUN_BIN" run --filter '@omp-deck/server' start > "$LOG_FILE" 2> "$ERR_FILE" &
	}
	wait_for_server && ok "Server started on port $PORT" && open_browser
}

linux_stop() {
	systemctl --user stop omp-deck.service 2>/dev/null || true
	if command -v lsof >/dev/null 2>&1; then
		local pid
		pid="$(lsof -ti:"$PORT" 2>/dev/null || true)"
		[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
	fi
	ok "Server stopped"
}

linux_status() {
	if systemctl --user is-active omp-deck.service >/dev/null 2>&1; then
		ok "Running (systemd active)"
	elif is_running; then
		ok "Running on port $PORT"
	else
		err "Not running"
		return 1
	fi
}

# ════════════════════════════════════════════════════════════════════
# Windows: Scheduled Task
# ════════════════════════════════════════════════════════════════════

windows_install() {
	local win_dir
	win_dir="$(echo "$DECK_DIR" | sed 's|/c/|C:/|; s|/|\\|g')"

	powershell.exe -NoProfile -Command "
		\$action = New-ScheduledTaskAction \
			-Execute '$BUN_BIN' \
			-Argument 'run --filter @omp-deck/server start' \
			-WorkingDirectory '$win_dir'
		\$trigger = New-ScheduledTaskTrigger -AtLogOn
		\$settings = New-ScheduledTaskSettingsSet \
			-AllowStartIfOnBatteries \
			-DontStopIfGoingOnBatteries \
			-RestartCount 3 \
			-RestartInterval (New-TimeSpan -Minutes 1) \
			-ExecutionTimeLimit ([TimeSpan]::Zero)
		Register-ScheduledTask -TaskName 'OMP Deck' \
			-Action \$action -Trigger \$trigger -Settings \$settings -Force
	" 2>/dev/null
	ok "Scheduled task registered: 'OMP Deck'"
	info "Auto-starts on login, auto-restarts on crash"
}

windows_uninstall() {
	powershell.exe -NoProfile -Command "
		Unregister-ScheduledTask -TaskName 'OMP Deck' -Confirm:\$false
	" 2>/dev/null || true
	ok "Scheduled task removed"
}

windows_start() {
	if is_running; then ok "Already running"; open_browser; return 0; fi
	powershell.exe -NoProfile -Command "Start-ScheduledTask -TaskName 'OMP Deck'" 2>/dev/null || {
		cd "$DECK_DIR"
		nohup "$BUN_BIN" run --filter '@omp-deck/server' start > "$LOG_FILE" 2> "$ERR_FILE" &
	}
	wait_for_server && ok "Server started on port $PORT" && open_browser
}

windows_stop() {
	powershell.exe -NoProfile -Command "Stop-ScheduledTask -TaskName 'OMP Deck'" 2>/dev/null || true
	# Kill by port
	local pid
	pid="$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $NF}' | head -1 || true)"
	[ -n "$pid" ] && taskkill.exe /PID "$pid" /F 2>/dev/null || true
	ok "Server stopped"
}

windows_status() {
	if is_running; then
		ok "Running on port $PORT"
	else
		err "Not running"
		return 1
	fi
}

# ════════════════════════════════════════════════════════════════════
# Dispatch
# ════════════════════════════════════════════════════════════════════

ACTION="${1:-status}"

# Platform-specific function prefix
case "$OS" in
	macos)   PREFIX="macos" ;;
	linux)   PREFIX="linux" ;;
	windows) PREFIX="windows" ;;
	*)
		echo "Unsupported OS: $(uname -s)"
		echo "Use: cd $DECK_DIR && bun run start"
		exit 1
		;;
esac

case "$ACTION" in
	install)
		echo -e "\n${C}Installing omp-deck daemon ($OS)...${N}"
		"${PREFIX}_install"
		echo ""
		"${PREFIX}_start" 2>/dev/null || true
		echo ""
		info "Manage with: omp-deck-daemon.sh {start|stop|status|logs|uninstall}"
		;;

	uninstall)
		echo -e "\n${Y}Removing omp-deck daemon ($OS)...${N}"
		"${PREFIX}_uninstall"
		;;

	start)
		echo -e "\n${C}Starting omp-deck ($OS)...${N}"
		"${PREFIX}_start"
		;;

	stop)
		echo -e "\n${Y}Stopping omp-deck ($OS)...${N}"
		"${PREFIX}_stop"
		;;

	restart)
		echo -e "\n${C}Restarting omp-deck ($OS)...${N}"
		"${PREFIX}_stop" 2>/dev/null || true
		sleep 2
		"${PREFIX}_start"
		;;

	status)
		echo -e "\n${C}omp-deck status ($OS):${N}"
		"${PREFIX}_status"
		;;

	logs)
		echo -e "\n${C}Tailing omp-deck logs (Ctrl+C to stop):${N}"
		if [ -f "$LOG_FILE" ]; then
			tail -f "$LOG_FILE"
		else
			info "No log file yet at $LOG_FILE"
		fi
		;;

	browser)
		open_browser
		ok "Opening browser..."
		;;

	*)
		echo "Usage: bash omp-deck-daemon.sh {install|uninstall|start|stop|restart|status|logs|browser}"
		echo ""
		echo "Commands:"
		echo "  install     Register as system service (auto-start on login)"
		echo "  uninstall   Remove system service"
		echo "  start       Start server in background (no terminal window)"
		echo "  stop        Stop server"
		echo "  restart     Restart server"
		echo "  status      Check if server is running"
		echo "  logs        Tail server logs"
		echo "  browser     Open browser to the deck"
		exit 1
		;;
esac
