# 边类型与权重

## 显式 graph_edges 关系

来自 `/api/memory/graph` 2026-06-30 快照：

| Relation | Count | 含义 |
|----------|-------|------|
| similar | 1153 | Stella 1792 维 embedding cosine ≥ 0.75 |
| ctx | 443 | 上下文耦合 |
| related_to | 321 | 通用关联 |
| extracted_from | 295 | fact 从某条 message 抽取 |
| summarizes | 92 | episodic 摘要指向 working memory |
| same_session | 25 | 同会话，weight 0.25 |
| references | 18 | 显式引用 |
| rel | 3 | 遗留旧格式 |

## Derived Edges（deck 生成）

`memory-service.ts` 在读取 SQLite 时动态生成以下边：

### 1. summarizes

- 来源：`episodic_memory.summary_of`（逗号分隔的 working memory ids）
- 方向：episodic → working
- weight: 1

### 2. extracted_from

- 来源：`facts.source_msg_id`
- 方向：fact → working / message
- weight: `facts.confidence ?? 0.7`

### 3. similar

- 来源：`memory_embeddings.embedding_json`
- 计算：cosineSimilarity(a, b) ≥ `SIMILARITY_THRESHOLD = 0.75`
- 方向：双向（但存储为有向）

### 4. same_session

- 来源：`working_memory.session_id`
- 条件：session_id 非空且不等于 "default"
- weight: `SAME_SESSION_WEIGHT = 0.25`
- 限制：每个 session 最多 `SAME_SESSION_MAX_EDGES_PER_SESSION = 5`，避免爆炸

### 5. supersedes

- 来源：`working_memory.superseded_by`
- 方向：旧记忆 → 新记忆
- weight: 1

## 权重规则

| 边类型 | 权重 | 是否动态 |
|--------|------|----------|
| summarizes | 1.0 | 是 |
| extracted_from | confidence / 0.7 | 是 |
| similar | cosine ≥ 0.75 | 是 |
| same_session | 0.25 | 是 |
| supersedes | 1.0 | 是 |
| graph_edges 显式边 | 表内 weight 字段 | 否 |

## 图截断

- 默认返回节点数：`MEMORY_GRAPH_DEFAULT_LIMIT = 120`
- 最大节点数：`MEMORY_GRAPH_MAX_LIMIT = 500`
- 超过则 `truncated: true`
- 节点按 `importance` 降序截取

## 改造建议

把旧记忆注入时，优先建立以下边：

1. `extracted_from`：把 fact 关联到原始 working memory。
2. `similar`：靠 Stella embedding 自动生成，无需手工。
3. `related_to` / `references`：手工连接跨主题概念。
4. `same_session`：同一工作会话内的记忆会自动生成。
