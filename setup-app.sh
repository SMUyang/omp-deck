#!/usr/bin/env bash
# setup-app.sh — Create desktop launcher for omp-deck
#
# Cross-platform: auto-detects macOS / Linux / Windows (WSL/Git Bash)
# Creates the appropriate desktop entry so you can click to launch.
#
# Usage:
#   bash setup-app.sh                # create launcher
#   bash setup-app.sh --remove       # remove launcher
#
set -euo pipefail

DECK_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="omp-deck"
ACTION="${1:-install}"

# ── Detect OS ───────────────────────────────────────────────────────
detect_os() {
	local uname_s
	uname_s="$(uname -s)"
	case "$uname_s" in
		Darwin) echo "macos" ;;
		Linux)  echo "linux" ;;
		MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
		*) echo "unknown" ;;
	esac
}

OS="$(detect_os)"

# ── Colors ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
	G='\033[32m'; Y='\033[33m'; C='\033[36m'; D='\033[90m'; N='\033[0m'
else
	G=''; Y=''; C=''; D=''; N=''
fi
ok()   { echo -e "  ${G}✓${N} $1"; }
info() { echo -e "  ${D}$1${N}"; }

# ── Core launch script (shared across platforms) ────────────────────
generate_launch_script() {
	local port="${OMP_DECK_PORT:-8787}"
	cat << LAUNCH
#!/usr/bin/env bash
# omp-deck desktop launcher — uses daemon, NO terminal window.
export DECK_DIR="$DECK_DIR"
export OMP_DECK_PORT="${port}"

# If already running, just open browser
if curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
	${OPEN_CMD} "http://127.0.0.1:${port}"
	exit 0
fi

cd "\$DECK_DIR"

# Build web if dist missing
if [ ! -d "apps/web/dist" ]; then
	bun run --filter '@omp-deck/web' build 2>/dev/null || true
fi

# Start via daemon (background, no terminal, auto-restart)
bash "\$DECK_DIR/omp-deck-daemon.sh" start 2>/dev/null || {
	# Fallback: direct nohup
	nohup bun run --filter '@omp-deck/server' start > /tmp/omp-deck-launch.log 2>&1 &
}

# Wait for server
for i in \$(seq 1 30); do
	if curl -sf "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then break; fi
	sleep 1
done

# Open browser
${OPEN_CMD} "http://127.0.0.1:${port}"
LAUNCH
}

# ── Remove ──────────────────────────────────────────────────────────
if [ "$ACTION" = "--remove" ]; then
	echo -e "\n${Y}Removing omp-deck launchers...${N}"
	# Stop daemon too
	bash "$DECK_DIR/omp-deck-daemon.sh" uninstall 2>/dev/null || true
	case "$OS" in
		macos)   rm -rf "$HOME/Applications/omp-deck.app" /Applications/omp-deck.app 2>/dev/null || true ;;
		linux)   rm -f "$HOME/.local/share/applications/omp-deck.desktop" /usr/share/applications/omp-deck.desktop 2>/dev/null || true ;;
		windows) rm -f "$HOME/Desktop/OMP Deck.lnk" "/c/Users/$USER/Desktop/OMP Deck.lnk" 2>/dev/null || true ;;
	esac
	ok "Removed (daemon + desktop icon)"
	exit 0
fi

# ── Install ─────────────────────────────────────────────────────────
echo ""
echo -e "  ${C}╔══════════════════════════════════════════════╗${N}"
echo -e "  ${C}║  ${D}omp-deck Desktop Launcher Setup${C}           ║${N}"
echo -e "  ${C}║  ${D}Platform: ${OS}${C}                              ║${N}"
echo -e "  ${C}╚══════════════════════════════════════════════╝${N}"
echo ""

# ── macOS: .app bundle ──────────────────────────────────────────────
setup_macos() {
	local app_dir="$HOME/Applications"
	mkdir -p "$app_dir"
	local bundle="$app_dir/omp-deck.app"
	rm -rf "$bundle"

	local contents="$bundle/Contents"
	local macos_dir="$contents/MacOS"
	local resources_dir="$contents/Resources"
	mkdir -p "$macos_dir" "$resources_dir"

	# Info.plist
	cat > "$contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>omp-deck</string>
	<key>CFBundleDisplayName</key><string>OMP Deck</string>
	<key>CFBundleIdentifier</key><string>com.ompdeck.app</string>
	<key>CFBundleVersion</key><string>0.7.10</string>
	<key>CFBundleShortVersionString</key><string>0.7.10</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>launch</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

	# Launch script
	OPEN_CMD="open"
	generate_launch_script > "$macos_dir/launch"
	chmod +x "$macos_dir/launch"

	ok "Created $bundle"
	info "Launch from Spotlight (search 'OMP Deck') or double-click in Finder"
}

# ── Linux: .desktop entry ───────────────────────────────────────────
setup_linux() {
	local app_dir="$HOME/.local/share/applications"
	mkdir -p "$app_dir"

	local launch_script="$HOME/.local/bin/omp-deck-launch"
	mkdir -p "$(dirname "$launch_script")"

	OPEN_CMD="xdg-open"
	generate_launch_script > "$launch_script"
	chmod +x "$launch_script"

	local desktop_file="$app_dir/omp-deck.desktop"
	cat > "$desktop_file" << DESKTOP
[Desktop Entry]
Type=Application
Name=OMP Deck
Comment=Cockpit for the omp coding agent
Exec=$launch_script
Icon=utilities-terminal
Terminal=false
Categories=Development;Network;
StartupNotify=true
DESKTOP

	# Update desktop database
	update-desktop-database "$app_dir" 2>/dev/null || true

	ok "Created $desktop_file"
	info "Launch from app menu or run: $launch_script"
}

# ── Windows: .lnk shortcut + .vbs launcher ──────────────────────────
setup_windows() {
	local desktop="$USERPROFILE/Desktop"
	[ -d "/c/Users/$USER/Desktop" ] && desktop="/c/Users/$USER/Desktop"

	local launch_script="$DECK_DIR/omp-deck-launch.vbs"

	# VBScript launcher (runs without showing a console window)
	cat > "$launch_script" << 'VBS'
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

deckDir = fso.GetParentFolderName(WScript.ScriptFullName)
port = "8787"

' Check if already running
Set exec = WshShell.Exec("cmd /c netstat -an | findstr :" & port)
If InStr(exec.StdOut.ReadAll, "LISTENING") > 0 Then
	WshShell.Run "http://127.0.0.1:" & port
	WScript.Quit
End If

' Start server
WshShell.CurrentDirectory = deckDir
WshShell.Run "cmd /c cd /d """ & deckDir & """ && bun run --filter ""@omp-deck/server"" start", 0, False

' Wait for server
For i = 1 To 30
	WScript.Sleep 1000
	On Error Resume Next
	Set http = CreateObject("MSXML2.XMLHTTP")
	http.Open "GET", "http://127.0.0.1:" & port & "/api/health", False
	http.Send
	If http.Status = 200 Then Exit For
	On Error GoTo 0
Next

' Open browser
WshShell.Run "http://127.0.0.1:" & port
VBS

	# Create desktop shortcut via PowerShell
	local win_deck_dir
	win_deck_dir=$(echo "$DECK_DIR" | sed 's|/c/|C:/|; s|/|\\|g')
	local win_script="$win_deck_dir\\omp-deck-launch.vbs"

	powershell.exe -NoProfile -Command "
		\$ws = New-Object -ComObject WScript.Shell
		\$shortcut = \$ws.CreateShortcut('$USERPROFILE\\Desktop\\OMP Deck.lnk')
		\$shortcut.TargetPath = 'wscript.exe'
		\$shortcut.Arguments = '\"$win_script\"'
		\$shortcut.WorkingDirectory = '$win_deck_dir'
		\$shortcut.IconLocation = 'shell32.dll,13'
		\$shortcut.Description = 'OMP Deck - Cockpit for omp coding agent'
		\$shortcut.Save()
	" 2>/dev/null

	ok "Created desktop shortcut + VBScript launcher"
	info "Double-click 'OMP Deck' on your Desktop"
}

# ── Dispatch ────────────────────────────────────────────────────────
case "$OS" in
	macos)   setup_macos ;;
	linux)   setup_linux ;;
	windows) setup_windows ;;
	*)
		echo "  Unknown OS. Use start-rpc-deck.sh instead."
		exit 1
		;;
esac

echo ""
echo -e "  ${G}Done!${N} Close this terminal — the launcher runs independently."
echo -e "  ${D}To stop: bash $DECK_DIR/start-rpc-deck.sh stop${N}"
echo ""
