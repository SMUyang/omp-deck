# RPC Backend — 使用外部 `omp` 替代内嵌 SDK

## 背景

omp-deck 默认内嵌 `@oh-my-pi/pi-coding-agent` SDK（in-process 模式）。当用户全局安装的 `omp` CLI 版本更新时，deck 的模型目录和功能会滞后于终端体验。

本次修改新增了 **opt-in RPC backend**：deck 通过 `omp --mode rpc` 子进程与用户全局安装的 `omp` 通信，确保 Web UI 与终端 `omp` 使用完全相同的引擎、模型目录和会话数据。

## 架构

```text
Browser UI
  ↓ REST / WebSocket
omp-deck server (Hono + Bun)
  ↓ stdio JSON-lines RPC
外部 omp --mode rpc (用户全局安装的 omp)
```

## 新增文件

| 文件 | 说明 |
|---|---|
| `apps/server/src/bridge/rpc-transport.ts` | JSON-lines 传输层：spawn `omp --mode rpc`，请求/响应关联（Map 追踪 pending），事件分发（Set 追踪 listeners），超时/错误处理，进程生命周期管理 |
| `apps/server/src/bridge/rpc.ts` | `RpcAgentBridge`（实现 `AgentBridge`）+ `RpcSessionHandle`（实现 `SessionHandle`）。每个 deck session 对应一个 RPC 子进程；模型列表共享一个 transport |

## 修改文件

| 文件 | 变更 |
|---|---|
| `apps/server/src/config.ts` | 新增 `agentBackend: "in-process" \| "rpc"` 和 `ompBin: string` 配置项，读取 `OMP_DECK_AGENT_BACKEND` 和 `OMP_DECK_OMP_BIN` 环境变量 |
| `apps/server/src/index.ts` | 根据 `config.agentBackend` 选择 `RpcAgentBridge` 或 `InProcessAgentBridge` |

## 启用方式

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OMP_DECK_AGENT_BACKEND` | `in-process` | 设为 `rpc` 启用外部 omp 后端 |
| `OMP_DECK_OMP_BIN` | `omp` | omp 二进制路径。**必须用绝对路径**，否则会命中 `node_modules/.bin/omp`（内嵌旧版 SDK） |

### 快速启动

```sh
OMP_DECK_AGENT_BACKEND=rpc \
OMP_DECK_OMP_BIN="$(which omp)" \
bun run dev
```

或使用安装脚本：

```sh
bash start-rpc-deck.sh
```

> **关键**：`OMP_DECK_OMP_BIN` 必须用**绝对路径**（如 `/Users/hyan/.bun/bin/omp`）。用 `"omp"` 会因 Bun 的 PATH 包含 `node_modules/.bin/` 而命中内嵌旧版 SDK，导致模型表不匹配。

## 已实现功能

| 功能 | 状态 | 实现方式 |
|---|---|---|
| 模型列表 (`listModels`) | ✅ | RPC `get_available_models`，共享 transport |
| 创建会话 (`createSession`) | ✅ | spawn 新 RPC 进程，`--model` + `--cwd` |
| 恢复会话 (`resumeSession`) | ✅ | spawn RPC 进程，`--resume <path>` |
| 历史会话列表 (`listSessions`) | ✅ | 直接读 `~/.omp/agent/sessions/*/*.jsonl` 磁盘文件（RPC 协议无 list_sessions 命令） |
| 发送 prompt (`prompt`) | ✅ | RPC `prompt` 命令 |
| 中断 (`abort`) | ✅ | RPC `abort` 命令 |
| 设置模型 (`setModel`) | ✅ | RPC `set_model` 命令 |
| 设置会话名 (`setName`) | ✅ | RPC `set_session_name` 命令 |
| 压缩上下文 (`compact`) | ✅ | RPC `compact` 命令 |
| 会话快照 (`snapshot`) | ✅ | 缓存 `get_state` 结果 |
| 事件订阅 (`subscribe`) | ✅ | RPC 事件流转发到 WS 层 |
| 消息历史 (`get_messages`) | ✅ | RPC `get_messages` 命令 |

## 尚未实现（降级处理）

| 功能 | 当前行为 |
|---|---|
| Plan mode | throw `not implemented` |
| Queue edit/cancel by id | 返回 `false` |
| Slash command dispatch | 回退到普通 prompt |
| Extension UI dialog 转发 | 未接入 |

## 验证结果

| 指标 | 内嵌 SDK（旧） | RPC backend（新） |
|---|---|---|
| ZAI 模型数 | 13 | **14** |
| `glm-5.2` | ❌ 缺失 | ✅ 存在 |
| 总模型数 | 2584（内嵌全量） | 63（与 CLI `omp` 一致） |
| 历史会话 | 0（stub） | **88**（磁盘扫描） |
| RPC 进程 | 无 | `bun /Users/hyan/.bun/bin/omp --mode rpc` |

## 技术要点

- RPC 协议为 stdin/stdout JSON-lines：命令带 `id`，响应 `type: "response"` 关联 `id`，其他 JSON 行为事件
- 传输层用 `Map<string, PendingRequest>` 追踪 pending 请求，`Set<RpcEventListener>` 追踪事件订阅者
- `listSessions` 直接读磁盘 JSONL 第一行（session header），不依赖 RPC 协议（协议无此命令）
- `getAgentDir` 从 `@oh-my-pi/pi-coding-agent` 重导出（deck 已有此依赖）
- 默认仍走 `InProcessAgentBridge`，RPC 纯 opt-in，不影响现有用户
