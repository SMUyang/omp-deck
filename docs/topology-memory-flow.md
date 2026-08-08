# topology-memory 节点构建、生成与完整流程

## 架构总览

```
~/.omp/agent/extensions/topology-memory/
├── index.ts           OMP 扩展入口（3 个生命周期钩子）
├── extract.ts         节点提取引擎（AgentMessage[] → TopologyNode[]）
├── store.ts           嵌入式 SQLite（bun:sqlite）
├── retrieve.ts        IDF 检索 + 邻居扩展 + focus 渲染
├── optimize.ts        自动优化：去重合并 + 重要性衰减 + 裁剪
├── cross-agent.ts     跨 Agent 记忆借入
├── subagent-sync.ts   Subagent 记忆继承 + 回传
├── skill-bridge.ts    Skill 进化桥接（拓扑 → daily-reflection）
├── types.ts           共享类型
└── types-extension.ts 扩展内部类型
```

### 三阶段生命周期

| 事件 | 阶段 | 职责 |
|---|---|---|
| `agent_end` | **写路径** | 从 `event.messages` 提取拓扑节点 → 存入 SQLite → 自动优化 |
| `context` | **读路径** | 从 SQLite 检索相关节点 → IDF 评分 → 渲染 focus → 注入为 hidden message |
| `session_shutdown` | **桥接** | 收集最近 24h 节点 → 写入 reflection markdown 供 skill 进化消费 |

---

## 完整数据流

```
用户发送消息
    │
    ▼
┌─────────────────────────────────────────┐
│  context 事件 (读路径)                    │
│                                          │
│  1. extractLatestUserText(event.messages)│
│     → query = "fix the auth bug"         │
│                                          │
│  2. tryDeckMode(apiBase, query)          │
│     → 如果 deck server 在线，用 HTTP 获取 │
│     → 否则回退到本地                      │
│                                          │
│  3. renderStoredFocus(sessionId, query)  │
│     → 从 SQLite 读取节点                  │
│     → retrieveTopology() IDF 评分        │
│     → renderFocus() 渲染 subgraph        │
│                                          │
│  4. replaceTopologyContext()             │
│     → 替换旧消息为 hidden custom message  │
│     → 保留最近 3 轮用户消息               │
│                                          │
│  5. return { messages: replaced }        │
│     → OMP 使用修改后的消息发送给 LLM      │
└─────────────────────────────────────────┘
    │
    ▼
Agent 处理 + 工具调用 + 响应
    │
    ▼
┌─────────────────────────────────────────┐
│  agent_end 事件 (写路径)                  │
│                                          │
│  1. event.messages: AgentMessage[]       │
│     (OMP 预解析，无需读 JSONL)            │
│                                          │
│  2. extractFromMessages(sessionId, msgs) │
│     → 遍历每条消息                       │
│     → textFromContent() 提取纯文本        │
│     → classifyUserText / classifyNonUser │
│     → makeNode() 生成 TopologyNode       │
│     → artifactMatches() 提取制品         │
│     → buildEdges() 构建边                │
│                                          │
│  3. store.replaceSession()               │
│     → 写入 SQLite                        │
│                                          │
│  4. if nodes >= 20:                      │
│     optimizeTopology()                   │
│     → mergeDuplicateNodes (Jaccard ≥0.65)│
│     → decayImportance (-10%/周, floor 0.3)│
│     → pruneExcess (>500 时裁剪)          │
└─────────────────────────────────────────┘
    │
    ▼ (会话结束时)
┌─────────────────────────────────────────┐
│  session_shutdown 事件 (桥接)             │
│                                          │
│  1. collectForReflection(nodes, edges)   │
│     → 筛选最近 24h 节点                   │
│     → 按 kind 分组                       │
│     → 生成 markdown                      │
│                                          │
│  2. mkdirSync(reflection/)               │
│  3. Bun.write(topology-input.md)         │
│     → 供 daily-reflection skill 消费     │
└─────────────────────────────────────────┘
```

---

## 节点构建详解

### 输入：OMP 预解析的 `AgentMessage[]`

`agent_end` 事件的 `event.messages` 提供 OMP 已解析的完整对话：

```typescript
interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | string;
  content: ContentBlock[] | string;
  id?: string;
  timestamp?: string;
}

// ContentBlock 类型：
type ContentBlock =
  | { type: "text"; text: string }              // 文本块 → 提取
  | { type: "thinking"; thinking: string }       // 思考块 → 跳过
  | { type: "toolCall"; name: string; ... }      // 工具调用 → 跳过
  | { type: "toolResult"; content: string; ... } // 工具结果 → 提取
```

### 文本提取 (`textFromContent`)

```
输入: content（字符串或 ContentBlock 数组）

如果是字符串 → 直接返回
如果是数组 → 逐块处理：
  { type: "text", text: "Hello" }       → "Hello"
  { type: "thinking", thinking: "..." } → ""（跳过）
  { type: "toolCall", ... }             → ""（跳过）
  拼接所有非空文本

输出: 纯文本字符串
```

---

## 节点分类规则

### 用户消息 (`classifyUserText`)

按优先级匹配（先匹配先返回）：

| 顺序 | 正则 | 节点类型 | importance |
|---|---|---|---|
| 1 | `\b(constraint\|requirement\|must\|cannot\|限制\|约束\|必须\|不能)\b` | `constraint` | 0.7 |
| 2 | `\b(goal\|objective\|target\|aim\|目标\|任务\|需求)\b` | `goal` | 0.7 |
| 3 | （默认） | `user_intent` | **1.0** |

### 非用户消息 (`classifyNonUserText`)

| role | 匹配规则 | 节点类型 | importance |
|---|---|---|---|
| `tool` / `tool_result` / `toolResult` | 噪声模式（`[Superseded...]`, `(no output)`, `Background job` 等） | **跳过** | — |
| 同上 | 含 `fail`/`error` + 数字 + 非 `0 fail` | `issue` | 0.85 |
| 同上 | 其他非噪声内容 | `evidence` | 0.85 |
| `assistant` | `\b(decision\|recommend\|architecture\|选择\|推荐\|决定\|方案)\b` | `decision` | 0.7 |
| `assistant` | 含 ` ``` ` 代码块 | `resolution` | 0.7 |
| `assistant` | `\b(wrote\|created\|modified\|fixed\|完成\|修改\|创建\|修复\|...)\b` + >20 字 | `action` | 0.7 |
| `assistant` | 其他 | **跳过** | — |

---

## 节点生成过程

`extractFromMessages()` 遍历 `event.messages`，为每条通过分类的消息生成 `TopologyNode`：

```typescript
interface TopologyNode {
  id: string;           // `${sessionId}:${messageId}`
  sessionId: string;
  kind: NodeKind;       // user_intent / goal / decision / evidence / ...
  messageId: string;    // OMP 消息 ID
  turnIndex: number;    // 递增序号（仅计有文本的消息）
  title: string;        // 首行，截断 200 字
  body: string;         // compressText：≤3 行→原文≤500字；>3 行→前2行≤500字
  importance: number;   // user_intent=1.0, evidence=0.85, 其他=0.7
  createdAt: string;    // msg.timestamp ?? new Date().toISOString()
  metadata: { role };   // 原始角色
}
```

### 制品提取 (`artifactMatches`)

从消息文本中用正则提取关联制品：

| 正则 | 制品类型 | 示例 |
|---|---|---|
| `FILE_RE`: `([\w./~@-]+\.(ts\|tsx\|js\|...))` | `file` | `auth.ts`, `config.json` |
| `COMMIT_RE`: `\b[0-9a-f]{7,40}\b` | `commit` | `a1b2c3d` |
| `TEST_COMMAND_RE`: `\b(bun\|npm\|...) (test\|run)...` | `test` | `bun test auth.test.ts` |

### 边构建

在节点生成过程中维护 `lastGoal` 指针：

| 条件 | 边类型 | relation | weight |
|---|---|---|---|
| 当前节点是 `goal` 且存在前一个 `goal` | `当前 → 前一个 goal` | `continues` | 0.65 |
| 当前节点是 `decision` 且存在 `goal` | `当前 → goal` | `depends_on` | 0.70 |

---

## 检索与注入流程

### IDF 评分公式

```
finalScore = 0.45 × queryMatch + 0.30 × importance + 0.25 × kindWeight

其中：
  queryMatch = Σ IDF(token) / √(queryTokenCount)
  IDF(token) = log(1 + N / docFreq(token))
  N = 总节点数
  docFreq(token) = 包含该 token 的节点数
```

### Kind 权重表

| Kind | Weight | 含义 |
|---|---|---|
| `resolution` | 0.95 | 代码解决方案（最高优先） |
| `decision` | 0.92 | 架构/技术决策 |
| `goal` | 0.90 | 用户目标 |
| `user_intent` | 0.88 | 用户意图 |
| `constraint` | 0.85 | 约束条件 |
| `evidence` | 0.80 | 测试/验证证据 |
| `issue` | 0.80 | 问题/错误 |
| `action` | 0.70 | 执行的动作 |
| `artifact` | 0.60 | 制品引用（最低） |

### 邻居扩展

```
1. IDF 评分排序 → 取 top-N 作为 seeds (outputLimit, 默认 40)
2. expandNeighbors(seeds, edges, hops=1):
   BFS 遍历边，将 seed 的直接邻居加入结果集
3. 合并 seeds + neighbors → 按 score 降序 → 取 outputLimit
4. selectEdges(): 保留两端节点都在选中集合中的边
```

### Focus 渲染格式

```xml
<session_topology_subgraph>
Session: session-xxx
Query: fix the auth bug
Nodes: 3 (of 3 candidates)

### [user_intent] How do I fix the auth bug?
Score: 1.576 | Turn: 1
[query match] auth (idf=0.85); [query match] bug (idf=1.61)
How do I fix the auth bug?

### [evidence] bun test auth.test.ts
Score: 0.675 | Turn: 4
[query match] auth (idf=0.85)
bun test auth.test.ts
5 pass 0 fail 10 expect

### Artifacts
- [file] auth.ts
- [test] bun test auth.test.ts
</session_topology_subgraph>
```

### 注入方式 (`replaceTopologyContext`)

```
原始消息列表: [msg1, msg2, msg3, ..., msgN]

处理逻辑:
1. 找到所有 user 消息的位置
2. 计算保留起点: 倒数第 keepTurns (默认 3) 个 user 消息
3. 保留起点之前的消息 → 替换为 1 条 hidden custom message (focus)
4. 保留起点之后的消息 → 原样保留

结果: [topology_focus_msg, msgN-2, msgN-1, msgN]
```

hidden custom message 结构：

```typescript
{
  role: "custom",
  content: "<session_topology_subgraph>...</session_topology_subgraph>",
  customType: "topology-memory-context",
  display: false  // UI 不显示，但 LLM 可见
}
```

---

## 自动优化 (`optimizeTopology`)

在 `agent_end` 中当节点数 ≥ 20 时自动执行：

### 1. 重要性衰减 (`decayImportance`)

```
30 天内: importance 不变
30 天后: 每周 -10%，下限 0.3
  decayFactor = max(0.3, 1 - 0.1 × weeksOver)
  importance *= decayFactor
```

### 2. 去重合并 (`mergeDuplicateNodes`)

```
对每对相同 kind 的节点计算 Jaccard 相似度:
  similarity = |A ∩ B| / |A ∪ B|  （基于 token 集合）

if similarity ≥ 0.65:
  保留 importance 更高的节点
  吸收更长的 body
  importance = max(A, B)
  删除另一个节点
```

### 3. 裁剪 (`pruneExcess`)

```
if nodes.length > 500:
  保护 user_intent + goal 节点（全部保留）
  其余按 importance 降序排列
  保留前 (500 - protected) 个
  删除其余
```

---

## 实测验证

### 测试 1：简单代码编写

```
输入: omp --print "Write hello world in Python"

agent_end 提取结果:
  Nodes: 3
    turn=1 [user_intent] Write hello world in Python
    turn=2 [evidence]    [hello.py#1830]     (文件写入工具结果)
    turn=3 [evidence]    Hello, World!        (运行结果工具结果)

  Artifacts:
    [file] hello.py
```

### 测试 2：代码编写 + 测试

```
输入: omp --print "Write a Python function to check if a number is prime, then run the test"

agent_end 提取结果:
  Nodes: 3
    turn=1 [user_intent] Write a Python function to check if a number is prime...
    turn=3 [issue]       [is_prime.py#D3AA]  (测试发现问题)
    turn=5 [evidence]    All checks passed ✅ (修复后验证通过)
```

---

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OMP_TOPOLOGY_MEMORY_ENABLED` | 启用 | 设为 `0` 禁用 |
| `OMP_TOPOLOGY_MEMORY_DB_PATH` | `~/.omp/agent/topology-memory.db` | SQLite 路径 |
| `OMP_TOPOLOGY_MEMORY_OUTPUT_NODES` | 40 | Focus 中最大节点数 |
| `OMP_TOPOLOGY_MEMORY_KEEP_TURNS` | 3 | 注入时保留的最近用户轮次 |
| `OMP_TOPOLOGY_MEMORY_MAX_FOCUS_CHARS` | 50000 | Focus 文本最大字符数 |
| `OMP_TOPOLOGY_MEMORY_TIMEOUT_MS` | 1500 | Deck HTTP 模式超时 |
| `OMP_DECK_API_BASE` | （未设置） | Deck server URL（设置后优先用 HTTP 模式） |

---

## pi-schedule-prompt 定时任务

| 任务名 | Cron | 说明 |
|---|---|---|
| `topology-daily-optimize` | `0 0 9 * * *` (每天 9am) | 全量优化 + skill 进化 |
| `topology-hourly-extract` | `0 0 * * * *` (每小时) | 增量提取近期会话 |

配置文件：
- 全局：`~/.pi/schedule-prompts.json`
- 设置：`~/.pi/schedule-prompts-settings.json`（widget 可见，jobs 共享）

---

## Skill 进化桥接

`session_shutdown` 时自动生成 reflection 输入：

```
~/.omp/agent/reflection/topology-input.md

内容示例:
  # Topology Reflection (2026-08-08T06:00:00Z)
  - Total nodes: 15
  - Total edges: 3

  ## User Intents
  - [turn 1] Write a Python function to check if a number is prime
  - [turn 3] Fix the failing test

  ## Evidence
  - [turn 5] All checks passed ✅

  ## Skill Evolution Candidates
  Multiple decisions detected — consider extracting a skill:
  - Use trial division with 6k±1 optimization for primality testing
```

daily-reflection skill 读取此文件，结合对话历史进行：
1. 记忆分类（memory / skill_update / skill_new / ignore）
2. Skill 进化建议
3. 写入 `~/.omp/reflection/daily/` 供 skill-evolution 消费
