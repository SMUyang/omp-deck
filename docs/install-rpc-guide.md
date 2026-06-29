# 安装指南

## 概述

omp-deck 支持两种后端模式：

| 模式 | 说明 | 适用场景 |
|---|---|---|
| **in-process**（默认） | 内嵌 `@oh-my-pi/pi-coding-agent` SDK，无需额外安装 omp | 快速体验、不需要终端 omp |
| **rpc**（推荐） | 通过 `omp --mode rpc` 子进程与全局安装的 omp 通信 | 已有 omp 终端用户，需要模型目录/会话与终端完全一致 |

RPC 模式确保 Web UI 与终端 `omp` 使用同一引擎——模型列表、会话历史、认证状态全部同步。

---

## 方式一：一键安装脚本

### macOS / Linux

**前提：**
- 已安装 [Bun](https://bun.sh) ≥ 1.3.14
- 已安装 omp CLI（`bun add -g @oh-my-pi/pi-coding-agent`）

```sh
git clone https://github.com/SMUyang/omp-deck.git
cd omp-deck
bash install-rpc-deck.sh
```

脚本自动完成：检查环境 → 克隆/更新仓库 → `bun install` → 验证 RPC 连通性 → 打印启动命令。

### Windows

**前提：**
- 已安装 [Bun](https://bun.sh) ≥ 1.3.14
- 已安装 Git（`winget install Git.Git`）
- 已安装 omp CLI（`bun add -g @oh-my-pi/pi-coding-agent`）

**PowerShell：**
```powershell
git clone https://github.com/SMUyang/omp-deck.git
cd omp-deck
.\install-rpc-deck.ps1
```

**CMD：**
```cmd
git clone https://github.com/SMUyang/omp-deck.git
cd omp-deck
powershell -NoProfile -ExecutionPolicy Bypass -File install-rpc-deck.ps1
```

如果需要指定安装目录或安装后直接启动：
```powershell
.\install-rpc-deck.ps1 -InstallDir C:\code\omp-deck -Start
```

### 安装后启动

**macOS / Linux：**
```sh
# 使用启动脚本
bash start-rpc-deck.sh          # 前台运行，Ctrl+C 停止
bash start-rpc-deck.sh start    # 后台运行，自动打开浏览器
bash start-rpc-deck.sh stop     # 停止后台进程

# 或手动启动
OMP_DECK_AGENT_BACKEND=rpc \
OMP_DECK_OMP_BIN="$(which omp)" \
bun run dev
```

**Windows：**
```cmd
REM 使用启动脚本
start-rpc-deck.cmd              REM 前台运行，Ctrl+C 停止
start-rpc-deck.cmd start        REM 后台运行，自动打开浏览器
start-rpc-deck.cmd stop         REM 停止后台进程

REM 或手动启动（PowerShell）
$env:OMP_DECK_AGENT_BACKEND = "rpc"
$env:OMP_DECK_OMP_BIN = (Get-Command omp).Source
bun run dev
```

打开 `http://127.0.0.1:5173` 即可使用。

---

## 方式二：手动安装

### 1. 安装 Bun

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

确认：`bun --version` 应输出 ≥ 1.3.14。

### 2. 安装 omp CLI

```sh
bun add -g @oh-my-pi/pi-coding-agent
```

确认 omp 可用且获取**绝对路径**：

```sh
# macOS / Linux
which omp
# 输出示例: /Users/yourname/.bun/bin/omp

# Windows (PowerShell)
(Get-Command omp).Source
# 输出示例: C:\Users\yourname\.bun\bin\omp.exe
```

> **重要**：记下绝对路径。启动时 `OMP_DECK_OMP_BIN` 必须用绝对路径，否则 Bun 会命中 `node_modules/.bin/omp`（内嵌旧版 SDK），导致模型表不匹配。

### 3. 克隆仓库

```sh
git clone https://github.com/SMUyang/omp-deck.git
cd omp-deck
bun install
```

### 4. 认证

如果你已经在终端用过 `omp`，认证信息保存在 `~/.omp/agent/auth.db`（Windows: `%USERPROFILE%\.omp\agent\auth.db`），deck 会自动读取，跳过此步。

如果从未用过 omp，任选一种方式：

- **终端认证**：运行 `omp`，按提示选择 provider（OAuth 或 API key）
- **Web UI 认证**：启动 deck 后，进入 Settings → Providers 点击 Sign in（OAuth），或 Settings → Env 粘贴 API key

### 5. 启动（RPC 模式）

**macOS / Linux：**
```sh
OMP_DECK_AGENT_BACKEND=rpc \
OMP_DECK_OMP_BIN=/Users/yourname/.bun/bin/omp \
bun run dev
```

**Windows (PowerShell)：**
```powershell
$env:OMP_DECK_AGENT_BACKEND = "rpc"
$env:OMP_DECK_OMP_BIN = "C:\Users\yourname\.bun\bin\omp.exe"
bun run dev
```

**Windows (CMD)：**
```cmd
set OMP_DECK_AGENT_BACKEND=rpc
set OMP_DECK_OMP_BIN=C:\Users\yourname\.bun\bin\omp.exe
bun run dev
```

打开 `http://127.0.0.1:5173`。

---

## 方式三：默认 in-process 模式

不需要安装 omp CLI，deck 内嵌 SDK 直接运行：

```sh
git clone https://github.com/SMUyang/omp-deck.git
cd omp-deck
bun install
bun run dev
```

或通过 npm 全局安装：

```sh
npm install -g omp-deck
omp-deck
```

打开 `http://127.0.0.1:8787`。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OMP_DECK_AGENT_BACKEND` | `in-process` | 设为 `rpc` 启用外部 omp 后端 |
| `OMP_DECK_OMP_BIN` | `omp` | omp 二进制路径。RPC 模式下**必须用绝对路径** |
| `OMP_DECK_PORT` | `8787` | 服务器端口 |
| `OMP_DECK_WEB_PORT` | `5173` | Vite 开发服务器端口 |
| `OMP_DECK_HOST` | `127.0.0.1` | 服务器绑定地址 |
| `OMP_DECK_DEFAULT_CWD` | `$HOME` | 默认工作目录 |
| `OMP_DECK_DB_PATH` | `data/deck.db` | SQLite 数据库路径 |
| `OMP_DECK_IDLE_TIMEOUT_MS` | `300000` | 会话无连接后多久回收（0 = 永不） |

---

## 验证安装

### macOS / Linux

```sh
# 1. 健康检查
curl http://127.0.0.1:8787/api/health
# 应返回 {"ok":true,...}

# 2. 模型列表（RPC 模式）
curl -s http://127.0.0.1:8787/api/models | python3 -c "
import sys, json
d = json.load(sys.stdin)
zai = [m['id'] for m in d['models'] if m['provider'] == 'zai']
print(f'ZAI models: {len(zai)}')
print('glm-5.2' in zai and 'glm-5.2: YES' or 'glm-5.2: NO')
"
# RPC 模式应返回 14 个 ZAI 模型且包含 glm-5.2

# 3. 历史会话
curl -s http://127.0.0.1:8787/api/sessions | python3 -c "
import sys, json
d = json.load(sys.stdin)
sessions = d.get('sessions', d)
print(f'Sessions: {len(sessions)}')
"

# 4. 确认 RPC 进程
ps aux | grep "omp --mode rpc"
```

### Windows (PowerShell)

```powershell
# 1. 健康检查
(Invoke-WebRequest http://127.0.0.1:8787/api/health -UseBasicParsing).Content

# 2. 模型列表
$models = (Invoke-WebRequest http://127.0.0.1:8787/api/models -UseBasicParsing).Content | ConvertFrom-Json
$zai = $models.models | Where-Object { $_.provider -eq "zai" }
Write-Output "ZAI models: $($zai.Count)"
Write-Output ("glm-5.2: " + ($zai.id -contains "glm-5.2"))

# 3. 历史会话
$sessions = (Invoke-WebRequest http://127.0.0.1:8787/api/sessions -UseBasicParsing).Content | ConvertFrom-Json
Write-Output "Sessions: $($sessions.sessions.Count)"

# 4. 确认 RPC 进程
Get-Process | Where-Object { $_.CommandLine -like "*omp*--mode*rpc*" } 2>$null
# 或
tasklist | findstr "omp"
```

---

## 常见问题

### 模型表缺少某些模型（如 glm-5.2）

**原因**：`OMP_DECK_OMP_BIN` 没用绝对路径，命中了 `node_modules/.bin/omp`（内嵌旧版 SDK）。

**解决**：用 `which omp`（macOS/Linux）或 `(Get-Command omp).Source`（Windows）获取绝对路径，然后用该路径启动。

### 历史会话不显示

**原因**：RPC 模式下 `listSessions` 直接读 `~/.omp/agent/sessions/` 磁盘文件。如果该目录为空或不存在，列表为空。

**解决**：确认你曾在终端用 `omp` 创建过会话。

### 端口被占用

**macOS / Linux：**
```sh
OMP_DECK_PORT=8877 OMP_DECK_WEB_PORT=5174 bun run dev
# 或杀掉占用进程
lsof -ti tcp:8787 | xargs kill -9
```

**Windows：**
```cmd
set OMP_DECK_PORT=8877
set OMP_DECK_WEB_PORT=5174
bun run dev
REM 或杀掉占用进程
for /f "tokens=5" %a in ('netstat -aon ^| findstr :8787 ^| findstr LISTENING') do taskkill /pid %a /f
```

### `omp --mode rpc` 报错

确认 omp 版本 ≥ 16.x：`omp --version`。如果版本过低：`bun add -g @oh-my-pi/pi-coding-agent`。

### `[rpc-transport] unparseable RPC line` 警告

omp 子进程的 `[pi-cliproxyapi]` 诊断日志混入 stdout，不影响功能。transport 会自动跳过非 JSON 行。

### Windows 执行策略限制

如果 PowerShell 脚本无法运行：
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

## 文件说明

| 文件 | 平台 | 说明 |
|---|---|---|
| `install-rpc-deck.sh` | macOS / Linux | 一键安装脚本 |
| `install-rpc-deck.ps1` | Windows | 一键安装脚本（PowerShell） |
| `start-rpc-deck.sh` | macOS / Linux | 启动脚本（foreground / background / stop / status） |
| `start-rpc-deck.cmd` | Windows | CMD 启动入口（只调用 PowerShell wrapper，避免 CMD 解析问题） |
| `start-rpc-deck.ps1` | Windows | 真正的启动逻辑：自动 `bun install`、构建前端、设置 RPC env、运行生产模式 |
| `docs/rpc-backend.md` | 跨平台 | RPC backend 技术文档 |
| `apps/server/src/bridge/rpc-transport.ts` | 跨平台 | JSON-lines 传输层源码 |
| `apps/server/src/bridge/rpc.ts` | 跨平台 | RPC bridge 实现源码 |

---

## 数据目录

| 路径 | 平台 | 说明 |
|---|---|---|
| `~/.omp/agent/` | macOS / Linux | omp 会话、认证、skills |
| `%USERPROFILE%\.omp\agent\` | Windows | 同上 |
| `~/.omp/agent/sessions/` | macOS / Linux | JSONL 会话文件 |
| `%USERPROFILE%\.omp\agent\sessions\` | Windows | 同上 |
| `~/.omp/agent/auth.db` | macOS / Linux | 认证存储 |
| `%USERPROFILE%\.omp\agent\auth.db` | Windows | 同上 |
| `apps/server/data/deck.db` | 跨平台 | deck SQLite（kanban、routines、inbox） |
| `.logs/` | 跨平台 | 启动脚本日志目录 |
