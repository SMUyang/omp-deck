# Windows 安装指南

> 最新更新：2026-07-29 — 包含拓扑 API 配置、自定义 Provider、跨盘符修复。

---

## 一、前置条件

| 组件 | 要求 | 安装命令 |
|---|---|---|
| **Bun** | ≥ 1.3.14 | `powershell -c "irm bun.sh/install.ps1 | iex"` |
| **Git** | 任意版本 | `winget install Git.Git` |
| **omp CLI** | ≥ 16.x | `bun add -g @oh-my-pi/pi-coding-agent` |

验证：

```powershell
bun --version          # ≥ 1.3.14
git --version          # 任意
omp --version          # ≥ 16.x
(Get-Command omp).Source
# 记住这个绝对路径，例如: C:\Users\你的用户名\.bun\bin\omp.exe
```

> **重要**：`omp` 的绝对路径后面要用到。如果不指定，Bun 可能命中 `node_modules\.bin\omp`（内嵌旧版 SDK），导致模型列表不匹配。

---

## 二、一键安装

### 方式 A：PowerShell 脚本（推荐）

```powershell
git clone https://github.com/SMUyang/omp-deck.git $env:USERPROFILE\AI\omp-deck
cd $env:USERPROFILE\AI\omp-deck
.\install-rpc-deck.ps1 -Start
```

脚本执行流程：

```
1. 检查 Bun、Git、omp CLI     ← 缺 Git 自动安装
2. 克隆 / 更新仓库
3. bun install
4. bun run --filter @omp-deck/web build   ← 构建前端
5. 配置拓扑 API（交互式）      ← 新增
6. 启动 deck
```

**拓扑 API 配置步骤（安装过程中）：**

```
── Configuring topology APIs ──

SiliconFlow — embedding + rerank (shared API key)
  Get a key at https://cloud.siliconflow.cn
  API key (blank = skip both): ********        ← 输入时不显示
  → Embedding + Rerank enabled

Extraction — fast model for topology node extraction
  Configure? [y/N] y
  Base URL [https://api.deepseek.com]:
  API Key: ********
  Model [deepseek-chat]:
  → Extraction enabled

✓ Topology config written to .env
```

> 跳过拓扑配置：`.\install-rpc-deck.ps1 -Start -SkipTopology`

### 方式 B：CMD 调用

```cmd
git clone https://github.com/SMUyang/omp-deck.git %USERPROFILE%\AI\omp-deck
cd %USERPROFILE%\AI\omp-deck
powershell -NoProfile -ExecutionPolicy Bypass -File install-rpc-deck.ps1 -Start
```

### 方式 C：手动安装

```powershell
git clone https://github.com/SMUyang/omp-deck.git $env:USERPROFILE\AI\omp-deck
cd $env:USERPROFILE\AI\omp-deck
bun install
bun run --filter @omp-deck/web build
```

---

## 三、启动

### 日常启动（推荐）

```cmd
start-rpc-deck.cmd              :: 前台运行，Ctrl+C 停止
start-rpc-deck.cmd start        :: 后台运行，自动打开浏览器
start-rpc-deck.cmd stop         :: 停止后台进程
start-rpc-deck.cmd status       :: 查看进程状态
```

或 PowerShell：

```powershell
.\start-rpc-deck.ps1            # 前台
.\start-rpc-deck.ps1 start      # 后台
```

启动脚本每次运行前自动 `git pull --ff-only` + `bun install`，保持最新。

启动后浏览器打开 **http://127.0.0.1:8787**。

### 启动配置 Banner

```
┌─ RPC Backend Configuration ─────────────────────────────┐
│  omp binary : C:\Users\QY\.bun\bin\omp.exe
│  server port: 8787
│  web port   : 8787
│  backend    : rpc
│  embedding  : on                                           ← 拓扑状态
│  rerank     : on
│  extraction : fast_model
└──────────────────────────────────────────────────────────┘
```

---

## 四、首次使用 — 6 步引导向导

首次打开 `http://127.0.0.1:8787` 自动进入向导：

| 步骤 | 内容 | 说明 |
|---|---|---|
| **1. Welcome** | 欢迎页 | 点击 Continue |
| **2. Knowledge base** | 初始化 KB | 点击 Initialize 创建 `~/kb` |
| **3. Connect provider** | 连接模型 | OAuth 登录或 API key 或 **自定义 Provider** |
| **4. Topology APIs** | 拓扑 API | SiliconFlow + Extraction（可跳过） |
| **5. Session greeting** | 自动问候 | 可选，开启 `/start` |
| **6. Done** | 完成 | 进入聊天 |

每步都可 Skip。重新打开向导：删除 `%LOCALAPPDATA%\omp-deck\onboarding.json` 后刷新。

---

## 五、自定义 Provider 配置

### 在向导中添加（Step 3）

向导第 3 步底部有 **Custom provider** 表单：

```
┌─ Custom provider ────────────────────────────────────┐
│ Any OpenAI-compatible endpoint. Written to omp's     │
│ models.yml — syncs to both terminal and deck.        │
│                                                       │
│ [Provider name________] [Base URL__________________] │
│ [API type: openai-completions ▼]                      │
│ [API key____________________________]                 │
│ ☐ No auth (local endpoint without API key)            │
│ [Model ID___________] [Display name____________]      │
│                                                       │
│ [Add provider]                                        │
└───────────────────────────────────────────────────────┘
```

**API 类型**（7 种，对应 omp schema）：
- `openai-completions` — 大多数第三方端点（默认）
- `openai-responses` — OpenAI Responses API
- `anthropic-messages` — Anthropic Messages API
- `google-generative-ai` / `google-vertex` — Google AI
- `azure-openai-responses` — Azure OpenAI
- `openai-codex-responses` — Codex 系列

**示例** — 添加一个本地 Ollama：

| 字段 | 值 |
|---|---|
| Provider name | `ollama` |
| Base URL | `http://localhost:11434/v1` |
| API type | `openai-completions` |
| API key | （勾选 "No auth"） |
| Model ID | `qwen3-coder:14b` |

保存后：
- 配置写入 `~/.omp/agent/models.yml`（omp 的权威配置文件）
- 终端 omp 和 deck 同时生效
- 模型选择器立即刷新
- **已有会话需新建会话才能使用新模型**

### 手动编辑 models.yml

也可以直接编辑文件：

```yaml
# %USERPROFILE%\.omp\agent\models.yml
providers:
  my-api:
    baseUrl: https://api.my-provider.com/v1
    api: openai-completions
    apiKey: sk-your-key-here
    models:
      - id: my-model-v1
        name: My Model V1
        contextWindow: 128000
        maxTokens: 4096
```

> 如果 `models.yml` 不存在但 `models.json` 存在，deck 会自动从 json 迁移。

---

## 六、Windows 特有注意事项

### 跨盘符工作区

deck 支持添加不同盘符的目录作为工作区（如 D:\Projects）：

- **目录浏览器**：右上角有路径输入框，可直接输入 `D:\Projects\myrepo` 按 Enter 跳转
- **系统目录保护**：`C:\Windows`、`C:\Program Files` 等系统目录不可浏览

### Provider / 模型未加载

**根因**：Windows 上 omp 子进程可能无法正确解析 `~` 路径（`HOME` vs `USERPROFILE`）。

**已修复**：deck 现在在启动 omp 子进程时显式设置 `OMP_AGENT_DIR`：

```
OMP_AGENT_DIR = %USERPROFILE%\.omp\agent
```

确保所有 omp 子进程（共享模型目录 + 每个会话）读取同一个 `models.yml`。

**诊断**：查看 models.yml 实际路径：

```powershell
(Invoke-WebRequest http://127.0.0.1:8787/api/providers/custom -UseBasicParsing).Content
# 返回 { "providers": [...], "path": "C:\\Users\\QY\\.omp\\agent\\models.yml" }
```

### PowerShell 执行策略

```powershell
# 如果脚本无法运行：
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Compact 超时

拓扑上下文压缩（auto-compact）涉及 LLM 调用，超时已从 30s 提升到 90s。如果仍超时：

```powershell
# 检查 extraction/embedding API 是否可达
curl https://api.siliconflow.cn/v1/embeddings -H "Authorization: Bearer YOUR_KEY" -d '{"model":"BAAI/bge-large-zh-v1.5","input":["test"]}'
```

---

## 七、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OMP_DECK_AGENT_BACKEND` | `rpc` | `rpc`（外部 omp）或 `in-process`（嵌入 SDK） |
| `OMP_DECK_OMP_BIN` | 自动检测 | omp.exe 绝对路径 |
| `OMP_DECK_PORT` | `8787` | 服务器端口 |
| `OMP_DECK_HOST` | `127.0.0.1` | 绑定地址（不要改为 0.0.0.0） |
| `OMP_DECK_DEFAULT_CWD` | `%USERPROFILE%` | 默认工作目录 |
| `OMP_AGENT_DIR` | `%USERPROFILE%\.omp\agent` | omp 配置目录（含 models.yml） |

拓扑 API 变量（安装脚本或向导自动写入 `.env`）：

| 变量 | 说明 |
|---|---|
| `OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED` | 启用 SiliconFlow 嵌入检索 |
| `OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY` | SiliconFlow API key |
| `OMP_DECK_TOPOLOGY_RERANK_ENABLED` | 启用 LLM 重排 |
| `OMP_DECK_TOPOLOGY_EXTRACTION_MODE` | `fast_model` 或 `regex` |
| `OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY` | 快速模型 API key |

---

## 八、验证安装

```powershell
# 1. 健康检查
(Invoke-WebRequest http://127.0.0.1:8787/api/health -UseBasicParsing).Content
# 应返回 {"ok":true,...}

# 2. 模型列表
$models = (Invoke-WebRequest http://127.0.0.1:8787/api/models -UseBasicParsing).Content | ConvertFrom-Json
Write-Output "Total models: $($models.models.Count)"

# 3. 自定义 Provider 列表
$providers = (Invoke-WebRequest http://127.0.0.1:8787/api/providers/custom -UseBasicParsing).Content | ConvertFrom-Json
Write-Output "Config path: $($providers.path)"
$providers.providers | Format-Table name, baseUrl, modelCount

# 4. omp 进程
Get-Process | Where-Object { $_.ProcessName -like "*omp*" }
```

---

## 九、常见问题

### Q: 模型列表为空

**A:** 检查三件事：
1. `OMP_DECK_OMP_BIN` 是否指向正确的 omp.exe（不是 `node_modules\.bin\omp`）
2. `%USERPROFILE%\.omp\agent\models.yml` 是否存在且有内容
3. omp 认证是否完成（终端运行 `omp` 测试能否正常对话）

### Q: 添加自定义 Provider 后旧会话看不到新模型

**A:** 正常行为。自定义 Provider 保存后，模型选择器会立即刷新，但**已有会话**的 omp 子进程仍使用旧配置。新建一个会话即可使用新模型。

### Q: D 盘目录无法浏览

**A:** 确保运行的是最新代码（`git pull`）。旧版本的沙箱检查会拒绝非 `%USERPROFILE%` 盘符的目录。最新版本已修复，支持所有盘符（系统目录除外）。

### Q: 端口被占用

```cmd
set OMP_DECK_PORT=8877
start-rpc-deck.cmd
:: 或杀掉占用进程
for /f "tokens=5" %a in ('netstat -aon ^| findstr :8787 ^| findstr LISTENING') do taskkill /pid %a /f
```

### Q: 后台进程怎么停

```cmd
start-rpc-deck.cmd stop
:: 如果不生效，手动杀进程
taskkill /f /im node.exe
```

---

## 十、文件位置

| 路径 | 说明 |
|---|---|
| `%USERPROFILE%\AI\omp-deck\` | 安装目录（默认） |
| `%USERPROFILE%\.omp\agent\models.yml` | omp 自定义 Provider 配置 |
| `%USERPROFILE%\.omp\agent\auth.db` | omp 认证数据 |
| `%LOCALAPPDATA%\omp-deck\.env` | deck 管理的环境变量 |
| `%LOCALAPPDATA%\omp-deck\onboarding.json` | 向导完成标记 |
| `.logs\` | 启动脚本日志 |
