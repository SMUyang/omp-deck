# 服务与 API

## 服务端入口

`apps/server/src/routes-memory.ts` 挂载三个 REST 端点：

```ts
export function buildMemoryRouter(config: Config): Hono {
  app.get("/memory/status", ...);
  app.get("/memory/search", ...);
  app.get("/memory/graph", ...);
}
```

端点在 `apps/server/src/routes.ts` 中通过 `app.route("/", buildMemoryRouter(config))` 挂载。

## GET /api/memory/status

返回跨 bank 的聚合状态。

```ts
interface MemoryStatusResponse {
  backend: MemoryBackendId;
  available: boolean;
  agentDir: string;
  memoryDir: string;
  banks: MemoryBankSummary[];
  totalWorking: number;
  totalEpisodic: number;
  totalFacts: number;
  totalEmbeddings: number;
  totalGraphEdges: number;
  message?: string;
}
```

## GET /api/memory/search?q=...&limit=...

- 跨所有 bank 全文搜索。
- 优先 FTS5，不可用时回退到 `LIKE`。
- 空查询时按 importance / timestamp 返回前 N 条。
- 内容截断至 `MEMORY_CONTENT_LIMIT = 2000` 字符。

## GET /api/memory/graph?q=...&bank=...&limit=...

- `q`：可选过滤，只返回与查询相关的 working memory 子图。
- `bank`：可选，只看指定 bank。
- `limit`：默认 120，最大 500。

返回：

```ts
interface MemoryGraphResponse {
  query: string;
  bank?: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  totalNodes: number;
  truncated: boolean;
}
```

## 核心服务函数

`apps/server/src/memory-service.ts`：

| 函数 | 作用 |
|------|------|
| `findMnemopiDbs(agentDir)` | 枚举 `~/.omp/agent/memories/mnemopi/banks/*/mnemopi.db` |
| `getMemoryStatus(agentDir)` | 读取所有 bank 统计 |
| `searchMemories(agentDir, query, limit)` | FTS/LIKE 搜索 |
| `getMemoryGraph(agentDir, options)` | 构建拓扑图 |

## 环境变量

- `OMP_AGENT_DIR`：覆盖默认 `~/.omp/agent`
- 否则使用 `path.join(os.homedir(), ".omp", "agent")`

## 改造建议

若要批量注入旧记忆，可：

1. 在 `memory-service.ts` 新增 `POST /api/memory/bulk`（或直接用 OMP `/mnemopi remember`）。
2. 每条旧记忆拆成 subject/predicate/object 写入 `facts`。
3. 用 `source_msg_id` 指向原始 working memory，自动生成 `extracted_from` 边。
4. 对跨主题概念，直接写入 `graph_edges` 表。
