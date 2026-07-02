# omp-deck 中文安装与使用指南

> 本指南适用于 [SMUyang/omp-deck](https://github.com/SMUyang/omp-deck) 分支（v0.7.0+）。
> 原项目：[bjb2/omp-deck](https://github.com/bjb2/omp-deck)（MIT 协议）

## 这是什么

omp-deck 是 [omp（Oh My Pi）](https://github.com/can1357/oh-my-pi) 编码助手的 Web 控制台。终端里的 omp 擅长写代码，但终端不擅长管理长时间运行的工作：追踪进度、从手机看一眼、记住上次做到哪了、决定是否让 AI 执行某个操作。

omp-deck 围绕聊天界面提供了：

- **看板（Kanban）** — 拖拽式任务管理，支持 `T-N` 编号
- **计划模式（Plan Mode）** — Shift+Tab 切换，AI 先调研再执行
- **收件箱（Inbox）** — 随手记想法/bug，一键转为任务
- **知识库（KB）** — 本地 Markdown 笔记 + 图谱 + 全文搜索
- **定时任务（Routines）** — cron 触发的多步骤流水线
- **记忆拓扑（Memory Topology）** — Mnemopi 长期记忆的图谱视图
- **消息桥（Messaging Bridge）** — Telegram 远程控制
- **多会话** — 每个会话独立模型、独立工作区

## 架构概览

```
浏览器 (React + Vite)
    │  REST + WebSocket
    ▼
omp-deck 服务端 (Bun + Hono)
    │
    ├── Agent Bridge ──────────────────────────
    │   ├── RpcAgentBridge（默认）
    │   │   每个会话启动一个 omp --mode rpc 子进程
    │   │   通过 stdio JSON-lines 通信
    │   │
    │   └── InProcessAgentBridge（回退）
    │       内嵌 @oh-my-pi/pi-coding-agent SDK
    │
    ├── 定时任务运行器 (croner)
    │   ├── cron / webhook / 手动 / 事件 触发
    │   ├── http 步骤 → 调用 deck 自身 API
    │   ├── agent 步骤 → omp -p <提示词> 无头模式
    │   └── transform / write / deck / mcp / wait 步骤
    │
    ├── deck.db (SQLite, WAL + busy_timeout)
    │   任务、收件箱、定时任务、会话、设置
    │
    └── Mnemopi 只读 (记忆拓扑)
        多个记忆库，working/episodic/facts，图边
```

### omp 的三条调用路径

| 路径 | 用途 | 方式 |
|------|------|------|
| **RPC 会话** | 浏览器交互式聊天 | `omp --mode rpc` 长驻子进程，每个会话一个 |
| **无头 agent** | 定时任务的 agent 步骤（如 LLM 分析） | `omp -p <提示词>` 一次性执行，捕获 stdout |
| **HTTP 自调** | 定时任务的 http 步骤 | 内部 bearer-token 请求 `127.0.0.1:PORT/api/...` |

---

## 安装方法

### 前提条件

| 软件 | 要求 | 安装方式 |
|------|------|---------|
| **Bun** | ≥ 1.3.14 | `curl -fsSL https://bun.sh/install \| bash` |
| **omp CLI** | 最新版 | `bun add -g @oh-my-pi/pi-coding-agent` |
| **Git** | 任意版本 | 脚本会自动检测并安装（见下方） |

> 如果 Git 未安装，安装脚本会自动处理：
> - **macOS**：通过 Homebrew 安装（没有 Homebrew 会先装 Homebrew）
> - **Linux**：自动检测 apt / dnf / yum / pacman / apk 并安装
> - **Windows**：通过 winget 或 chocolatey 安装

### 方法 A：RPC 后端安装脚本（推荐）

这是本分支的推荐安装方式。脚本会检查环境、克隆仓库、安装依赖、验证 `omp --mode rpc`，然后启动 deck。

#### macOS / Linux

```sh
# 一键安装 + 立即启动
bash install-rpc-deck.sh --start

# 仅安装（不启动）
bash install-rpc-deck.sh

# 指定安装目录
bash install-rpc-deck.sh --dir ~/AI/omp-deck --start
```

#### Windows

```powershell
# PowerShell
.\install-rpc-deck.ps1 -Start

# CMD
powershell -NoProfile -ExecutionPolicy Bypass -File install-rpc-deck.ps1 -Start

# 指定安装目录
.\install-rpc-deck.ps1 -InstallDir C:\code\omp-deck -Start
```

### 方法 B：npm 全局安装（使用内嵌 SDK）

不需要单独安装 omp CLI，deck 内嵌了 agent SDK。

```sh
npm install -g omp-deck
omp-deck
```

> **注意**：此方式使用内嵌的 SDK 版本，可能与终端 `omp` 版本不一致。
> 如果需要完全一致的体验（相同模型列表、相同会话数据），请使用方法 A。

### 方法 C：源码安装（开发模式）

```sh
git clone https://github.com/SMUyang/omp-deck.git
cd omp-deck
bun install
bun run dev
```

开发模式使用 Vite 热重载，访问 `http://127.0.0.1:5173`。

### 方法 D：Docker

```sh
docker-compose up -d
```

内置 `restart: unless-stopped` 自动重启和健康检查。详见 [部署文档](../docs/deployment.md)。

---

## 启动与运行

### macOS / Linux

```sh
# 前台运行（Ctrl+C 停止）
bash start-rpc-deck.sh

# 后台运行（自动打开浏览器）
bash start-rpc-deck.sh start

# 停止后台实例
bash start-rpc-deck.sh stop

# 查看运行状态
bash start-rpc-deck.sh status
```

### Windows

```powershell
# 前台运行
.\start-rpc-deck.ps1

# 后台运行
.\start-rpc-deck.ps1 start

# 停止
.\start-rpc-deck.ps1 stop

# 状态
.\start-rpc-deck.ps1 status

# 或直接双击 Start-OMP-Deck.cmd
```

> **自动更新**：每次启动时，脚本会自动执行 `git pull --ff-only origin main`
> 和 `bun install`，确保代码是最新的。拉取失败会打印警告但不阻止启动。

### 后台运行方案对比

| 方式 | 持久性 | 自动重启 | 开机自启 |
|------|--------|---------|---------|
| `start-rpc-deck.sh start`（nohup） | 进程级 | ✗ | ✗ |
| `start-rpc-deck.ps1 start`（Start-Process） | 进程级 | ✗ | ✗ |
| `docker-compose up -d` | 容器级 | ✓ | ✓ |
| `bun run start`（前台） | 终端会话 | ✗ | ✗ |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OMP_DECK_PORT` | `8787` | 服务端端口 |
| `OMP_DECK_WEB_PORT` | `5173` | Vite 开发服务器端口（仅开发模式） |
| `OMP_DECK_HOST` | `127.0.0.1` | 绑定地址 |
| `OMP_DECK_AGENT_BACKEND` | `rpc` | `rpc`（外部 omp）或 `in-process`（内嵌 SDK） |
| `OMP_DECK_OMP_BIN` | 自动检测 | omp 二进制路径 |
| `OMP_DECK_DEFAULT_CWD` | `$HOME` | 默认工作区 |
| `OMP_DECK_DB_PATH` | `data/deck.db` | SQLite 数据库路径 |
| `OMP_DECK_IDLE_TIMEOUT_MS` | `300000` | 会话空闲回收时间（毫秒，0 禁用） |
| `OMP_DECK_AUTO_START` | `/start` | 新会话自动执行的命令（设为空禁用） |

### 使用示例

```sh
# 指定端口和工作区
OMP_DECK_PORT=8902 OMP_DECK_DEFAULT_CWD=~/projects/myapp bash start-rpc-deck.sh

# 使用内嵌 SDK 模式（不需要 omp CLI）
OMP_DECK_AGENT_BACKEND=in-process bash start-rpc-deck.sh

# 禁用会话空闲回收
OMP_DECK_IDLE_TIMEOUT_MS=0 bun run start
```

---

## 首次配置

### 认证（一次性）

1. 打开 `http://127.0.0.1:8787`（或你设置的端口）
2. 进入 **Settings → Providers**
3. 选择你的 AI 提供商：
   - **Claude Pro / Max、ChatGPT Plus / Pro** → 点击 *Sign in*，浏览器 OAuth 认证
   - **Anthropic / OpenAI / OpenRouter / Google API Key** → Settings → Env → 粘贴密钥
4. 认证信息存储在 `~/.omp/agent/auth.db`，终端 omp 和 deck 共享

> 如果你已经在终端使用过 `omp`，deck 会自动发现现有的 `~/.omp/agent` 配置，无需重新认证。

### 选择模型

在聊天界面底部选择模型。RPC 后端模式下，你看到的是终端 `omp` 的完整模型列表（包括所有通过 CLIProxyAPI 注册的自定义模型）。

---

## 定时任务（Routines）

### 概念

定时任务是多步骤流水线，支持以下触发方式：

- **cron** — 定时触发（如每 30 分钟）
- **webhook** — HTTP 回调触发
- **manual** — 手动触发
- **event** — 事件触发

### 步骤类型

| 类型 | 说明 |
|------|------|
| `http` | HTTP 请求（通常调用 deck 自身 API） |
| `agent` | 调用 omp 无头模式执行 LLM 分析 |
| `transform` | 纯 JavaScript 计算（沙箱执行） |
| `write` | 写文件 |
| `deck` | deck 操作（创建 inbox 项等） |
| `set_state` | 设置任务状态 |
| `mcp` | MCP 工具调用 |
| `wait` | 等待指定时间 |

### 内置示例：memory-graph-maintainer

每 30 分钟自动运行：

1. `fetch_status` — 获取记忆库状态
2. `fetch_graph` — 获取记忆拓扑图
3. `compute_stats` — 计算图统计（孤立节点、边类型）
4. `analyze` — LLM 分析图缺口和缺失连接
5. `write_report` — 将分析结果写入收件箱
6. `persist_state` — 保存签名，避免重复分析

### 创建自定义定时任务

在 deck UI 的 Routines 页面，使用可视化画布或 YAML 编辑器创建。

YAML 示例：

```yaml
name: my-daily-task
trigger:
  - cron: "0 9 * * *"  # 每天 9 点
concurrency: skip
budget:
  max_duration_secs: 120
  max_llm_cost_usd: 0.05
steps:
  - id: fetch_data
    type: http
    method: GET
    url: "http://127.0.0.1:{{ env.OMP_DECK_PORT }}/api/tasks"
    expect_json: true

  - id: summarize
    type: agent
    prompt: |
      总结今天的任务状态：
      {{ steps.fetch_data.json | json }}

  - id: notify
    type: deck
    action: create_inbox_item
    kind: capture
    title: "每日任务摘要 - {{ run.date }}"
    body: "{{ steps.summarize.stdout }}"
```

---

## 记忆系统

### Mnemopi 长期记忆

omp 使用 Mnemopi 在会话间记住信息。记忆按项目（bank）分组：

| 记忆类型 | 说明 |
|---------|------|
| **working** | 工作记忆（当前活跃的事实和决策） |
| **episodic** | 情景记忆（会话摘要） |
| **facts** | 提取的事实三元组 |
| **graph_edges** | 记忆间的语义连接 |

### 记忆拓扑图

在 deck UI 的 Memory 页面（`/memory`）可以查看：

- **状态面板** — 每个 bank 的记忆数量统计
- **拓扑图** — 节点（记忆）和边（关系）的力导向图
- **搜索** — 全文搜索所有记忆库

API 端点：

```
GET /api/memory/status          # 记忆库状态
GET /api/memory/graph           # 记忆拓扑图
GET /api/memory/search?q=关键词  # 搜索记忆
```

---

## 常见问题

### Q: 启动时端口被占用

```sh
# 查看占用进程
lsof -i :8787

# 使用其他端口
OMP_DECK_PORT=8902 bash start-rpc-deck.sh
```

### Q: RPC 后端启动失败

检查 omp 是否可用：

```sh
omp --version
echo '{"id":"test","type":"get_available_models"}' | omp --mode rpc | head -5
```

如果 omp 不在 PATH 中，设置 `OMP_DECK_OMP_BIN`：

```sh
OMP_DECK_OMP_BIN=/path/to/omp bash start-rpc-deck.sh
```

### Q: 回退到内嵌 SDK 模式

如果不想使用外部 omp：

```sh
OMP_DECK_AGENT_BACKEND=in-process bun run dev
```

### Q: 定时任务报 SQLITE_BUSY

已在 v0.6.1 修复（添加了 `PRAGMA busy_timeout = 5000`）。如果仍有问题，确保运行的是最新代码：

```sh
bash start-rpc-deck.sh status  # 停止旧实例
git pull origin main
bash start-rpc-deck.sh         # 重新启动
```

### Q: 如何从手机访问

deck 默认只监听 `127.0.0.1`。推荐使用 Tailscale：

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

然后通过 `https://你的机器名.tail-xxx.ts.net` 访问。

---

## 文件结构

```
~/AI/omp-deck/
├── apps/
│   ├── server/          # Bun + Hono 服务端
│   │   ├── src/
│   │   │   ├── index.ts         # 入口
│   │   │   ├── config.ts        # 配置加载
│   │   │   ├── bridge/          # Agent 桥（RPC + InProcess）
│   │   │   │   ├── rpc-transport.ts   # RPC JSON-lines 传输层
│   │   │   │   ├── rpc.ts             # RpcAgentBridge
│   │   │   │   └── in-process.ts      # InProcessAgentBridge
│   │   │   ├── routines/        # 定时任务
│   │   │   │   ├── v1-runner.ts      # V1 流水线执行器
│   │   │   │   └── steps/            # 步骤执行器
│   │   │   ├── memory-service.ts # 记忆拓扑服务
│   │   │   └── db/              # SQLite 数据层
│   │   └── data/deck.db         # 主数据库
│   ├── web/                     # React + Vite 前端
│   └── bridges/telegram/        # Telegram 桥
├── packages/protocol/           # 共享类型 + JSON Schema
├── install-rpc-deck.sh          # macOS/Linux 安装脚本
├── install-rpc-deck.ps1         # Windows 安装脚本
├── start-rpc-deck.sh            # macOS/Linux 启动脚本
├── start-rpc-deck.ps1           # Windows 启动脚本
├── Start-OMP-Deck.cmd           # Windows CMD 快捷方式
└── docker-compose.yml           # Docker 部署
```

---

## 相关文档

- [英文 README](../README.md)
- [RPC 安装指南（英文）](./install-rpc-guide.md)
- [部署文档](./deployment.md)
- [配置参考](./configuration.md)
- [定时任务教程](./routines-v1-tutorial.md)
- [Telegram 桥](./telegram.md)
- [架构文档](./architecture.md)
