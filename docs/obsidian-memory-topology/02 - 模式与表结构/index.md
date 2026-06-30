# 模式与表结构

Mnemopi 使用 Bun SQLite。deck 的 `memory-service.ts` 采用只读访问，并容忍旧 schema 中缺失的列。

## 核心表

| 表 | 说明 | deck 中用途 |
|----|------|-------------|
| `working_memory` | 工作记忆 | graph seed、FTS 搜索、node kind=working |
| `episodic_memory` | 情节记忆 | node kind=episodic、`summarizes` 边 |
| `facts` | 抽取事实 | node kind=fact、`extracted_from` 边 |
| `memory_embeddings` | 向量 | `similar` 边计算 |
| `graph_edges` | 显式图边 | 直接读取 |
| `reference_nodes` / gist | 引用节点 | 端点解析 fallback |
| `fts_working` | FTS5 虚拟表 | 全文搜索 |

## working_memory 列（deck 使用）

```ts
interface RawWorkingMemoryRow {
  id: string;
  content: string;
  source: string | null;
  timestamp: string | null;
  importance: number | null;
  memory_type: string | null;
  recall_count: number | null;
  superseded_by: string | null;
  session_id?: string | null;
}
```

## episodic_memory 列（deck 使用）

```ts
interface RawEpisodicGraphRow {
  id: string;
  content: string | null;
  summary_of: string | null;
  importance: number | null;
  timestamp: string | null;
}
```

`summary_of` 是逗号分隔的 working memory id 列表。

## facts 列（deck 使用）

```ts
interface RawFactGraphRow {
  fact_id: string;
  source_msg_id: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  confidence: number | null;
  timestamp: string | null;
}
```

最佳实践：把旧记忆改造成 `subject | predicate | object` 三元组写入 `facts`，并设置 `source_msg_id` 指向原始 working memory。

## graph_edges 列兼容

deck 使用候选列名映射，以兼容不同 Mnemopi schema：

```ts
const GRAPH_EDGE_COLUMN_CANDIDATES = {
  source: ["source_id", "source", "from_id", "from", "src"],
  target: ["target_id", "target", "to_id", "to", "dst"],
  relation: ["relationship", "relation", "type", "edge_type", "label"],
  weight: ["weight", "score", "strength"],
};
```

## memory_embeddings

```ts
interface RawEmbeddingRow {
  memory_id: string;
  embedding_json: string;
}
```

embedding 是 JSON 序列化的 float 数组。deck 使用本地 cosine 相似度：

```ts
SIMILARITY_THRESHOLD = 0.75;
```

## 配置读取

`memory-service.ts` 读取 `~/.omp/agent/config.yml` 的 `memory.backend`：

```ts
function readMemoryBackend(agentDir: string): string {
  // 解析 YAML，取 memory.backend，默认 "mnemopi"
}
```
