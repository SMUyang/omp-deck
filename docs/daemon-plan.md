# omp-deck 后台守护进程计划

## 现状

```
当前启动方式:
  bun run start                ← 前台运行, 终端必须保持打开
  bash start-rpc-deck.sh start ← nohup 后台, 但仍弹终端
  setup-app.sh (.app/.desktop/.lnk) ← 启动器内部 nohup, 但 .app 弹 Terminal.app

痛点:
  ✗ macOS: .app 双击 → Terminal.app 窗口弹出
  ✗ Linux: .desktop → 有时弹出终端窗口
  ✗ Windows: .vbs → 基本无窗口, 但不可靠
  ✗ 无开机自启动
  ✗ 无进程健康检查/自动重启
```

---

## 方案：跨平台守护进程

### 架构

```
omp-deck-daemon.sh  (统一入口)
  ├── install    → 注册系统级服务
  ├── uninstall  → 移除系统级服务
  ├── start      → 启动后台进程 (无窗口)
  ├── stop       → 停止
  ├── status     → 检查运行状态
  ├── logs       → 查看日志
  └── restart    → 重启

平台实现:
  macOS:  launchd plist (~/Library/LaunchAgents/)
  Linux:  systemd --user service (~/.config/systemd/user/)
  Windows: 计划任务 (schtasks) + 隐藏窗口
```

### macOS: launchd

```xml
<!-- ~/Library/LaunchAgents/com.ompdeck.server.plist -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ompdeck.server</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/xxx/.bun/bin/bun</string>
    <string>run</string>
    <string>--filter</string>
    <string>@omp-deck/server</string>
    <string>start</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/xxx/AI/omp-deck</string>

  <key>RunAtLoad</key>          <!-- 开机/登录自启动 -->
  <true/>

  <key>KeepAlive</key>          <!-- 崩溃自动重启 -->
  <true/>

  <key>StandardOutPath</key>    <!-- 日志 (无终端) -->
  <string>/tmp/omp-deck.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/omp-deck.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
```

**优势**：
- 零终端窗口 — launchd 直接管理进程
- `RunAtLoad` = 开机自启
- `KeepAlive` = 崩溃自动重启
- `launchctl load/unload` 一键控制

### Linux: systemd --user

```ini
# ~/.config/systemd/user/omp-deck.service
[Unit]
Description=OMP Deck Server
After=network.target

[Service]
Type=simple
ExecStart=/home/xxx/.bun/bin/bun run --filter @omp-deck/server start
WorkingDirectory=/home/xxx/omp-deck
Restart=always
RestartSec=3
StandardOutput=append:/tmp/omp-deck.log
StandardError=append:/tmp/omp-deck.err.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

**控制**:
```bash
systemctl --user enable omp-deck   # 开机自启
systemctl --user start omp-deck    # 启动
systemctl --user status omp-deck   # 状态
journalctl --user -u omp-deck -f   # 日志
```

### Windows: 计划任务 + 隐藏窗口

```powershell
# 注册计划任务: 登录时自动启动, 隐藏窗口
$action = New-ScheduledTaskAction `
  -Execute "$env:USERPROFILE\.bun\bin\bun.exe" `
  -Argument "run --filter @omp-deck/server start" `
  -WorkingDirectory "$env:USERPROFILE\omp-deck"

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "OMP Deck" `
  -Action $action -Trigger $trigger -Settings $settings -Force
```

**控制**:
```powershell
Start-ScheduledTask -TaskName "OMP Deck"
Stop-ScheduledTask -TaskName "OMP Deck"
Get-ScheduledTask -TaskName "OMP Deck" | Get-ScheduledTaskInfo
```

---

## 统一管理脚本

```bash
#!/usr/bin/env bash
# omp-deck-daemon.sh — 跨平台后台守护进程管理

case "$1" in
  install)
    # macOS:  生成 plist → launchctl load
    # Linux:  生成 service → systemctl --user enable
    # Windows: 注册计划任务
    ;;

  uninstall)
    # macOS:  launchctl unload → 删除 plist
    # Linux:  systemctl --user disable → 删除 service
    # Windows: Unregister-ScheduledTask
    ;;

  start|stop|restart|status)
    # macOS:  launchctl start/stop com.ompdeck.server
    # Linux:  systemctl --user start/stop/restart/status
    # Windows: Start/Stop-ScheduledTask
    ;;

  logs)
    # 全平台: tail -f /tmp/omp-deck.log
    ;;
esac
```

---

## 与 setup-app.sh 集成

```
用户安装流程:
  bash setup-app.sh         ← 创建桌面图标
  bash omp-deck-daemon.sh install  ← 注册后台服务 (可选)

或一步到位:
  bash install-ui.sh        ← 安装脚本自动:
    1. clone + bun install
    2. 注册守护进程 (install daemon)
    3. 创建桌面图标
    4. 启动服务 + 打开浏览器

效果:
  ✓ 桌面图标双击 → 直接打开浏览器 (无终端)
  ✓ 开机自动启动 (无需手动)
  ✓ 崩溃自动重启
  ✓ 日志写入文件 (不弹终端)
```

---

## 文件规划

```
omp-deck/
├── omp-deck-daemon.sh          ← 统一守护进程管理
├── setup-app.sh                ← 桌面图标 (更新: 调用 daemon)
├── install-ui.sh               ← 安装脚本 (更新: 含 daemon 注册)
├── scripts/
│   ├── com.ompdeck.plist.template    ← macOS launchd 模板
│   ├── omp-deck.service.template     ← Linux systemd 模板
│   └── omp-deck-task.ps1.template   ← Windows 计划任务模板
```

---

## 验收标准

```
Phase 1: 守护进程核心
  ✓ omp-deck-daemon.sh install → 注册服务, 无终端弹出
  ✓ omp-deck-daemon.sh start → 后台启动, 浏览器自动打开
  ✓ omp-deck-daemon.sh stop → 干净停止
  ✓ omp-deck-daemon.sh status → 查看运行状态
  ✓ omp-deck-daemon.sh logs → 查看日志

Phase 2: 系统集成
  ✓ macOS: 登录自启动
  ✓ Linux: 开机自启动
  ✓ Windows: 登录自启动
  ✓ 崩溃自动重启 (kill -9 后 3 秒恢复)

Phase 3: 桌面图标集成
  ✓ 双击 .app/.desktop/.lnk → 打开浏览器 (无终端)
  ✓ 右键菜单: Start/Stop/Logs
  ✓ 系统托盘 (Phase 3+, 与 Tauri 集成)
```
