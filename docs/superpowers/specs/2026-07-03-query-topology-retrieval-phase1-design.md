SPEC-V0-DRAFT: 本地 query-time topology retrieval 替换 compact focus (Phase 1)

## 目标

把 compact 前的 focus 生成从“按重要性截取 graph”升级为“按当前 user query 召回 + 1-hop 扩展 + sanitized JSON focus”。Phase 1 不接外部 API。

## 范围内

1. 新增 `apps/server/src/session-topology-retrieval.ts`:
   - `retrieveTopology(input)`: 本地候选召回 + 1-hop 扩展 + 输出 limit
   - 内部 scoring 全部留服务端；返回结构只用于本地排序
2. 替换 `apps/server/src/session-context.ts` 中 compact 路径使用的 focus:
   - 保留 `getStoredSessionTopologyFocus()` 作为 no-rerank path
   - 新增 `getStoredQueryTopologyFocus({ sessionId, query, contextPercent })`
3. 两个 bridge 的 `prompt()` 在调用 `maybeAutoCompactContext()` 前把当前 user message text 透传:
   - RPC: 在 `prompt()` 内取 `text` 传进 `maybeAutoCompactContext(currentQuery)`
   - In-process: 同上
4. 测试:
   - candidate 召回 limit
   - 1-hop 扩展边界
   - 空 graph / 空 query / 空 prompt-text 返回空字符串
   - 输出 JSON 字段白名单（无 importance/weight/confidence）
   - bridge 透传 currentQuery（mock 测试，不走真实 RPC）
5. 默认 limits: 50 candidate / 10 output nodes / 18 edges / 12 artifacts / 1-hop

## 不在范围

- 外部 API rerank (Phase 2)
- 每 3 轮 graph refinement
- DB schema 变更
- 前端 Graph UI

## API

```ts
export interface RetrieveTopologyInput {
  sessionId: string;
  query: string;            // 来自 user latest prompt
  candidateNodeLimit: number; // default 50
  expansionHops: 1 | 2;      // default 1
  outputNodeLimit: number;   // default 10
  outputEdgeLimit: number;   // default 18
  outputArtifactLimit: number; // default 12
}

export interface RetrievedTopology {
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  artifacts: Array<{ kind: string; ref: string; nodeId?: string; label?: string }>;
  omitted: { nodeCount: number; edgeCount: number; reason: string };
}

export function retrieveTopology(input: RetrieveTopologyInput): RetrievedTopology | undefined;
```

返回 `undefined` 表示 graph 为空，调用方应 skip compact。

## 行为

- query 为空 → 仅按 importance + recency 选 top-K
- query 非空 → 文本匹配权重叠加
- 1-hop 扩展：把 top candidate 的 source/target 邻居加入候选
- 输出 limit：选 top N nodes
- 边过滤：source 和 target 都在 selected 里的边才输出
- artifact 过滤：仅 attached 到 selected nodes 的输出
- sanitization：导出 focus 时只发 id/kind/title/body/source/relation/ref/nodeId/label

## 失败

- graph 节点为空：返回 undefined → bridge 跳过 compact
- query 编码/匹配异常：catch + warn + 走无 query 路径
- 边界/limit 异常：静默 clamp

## 测试

```ts
- retrieveTopology returns undefined when graph is empty
- retrieveTopology ranks query-relevant nodes first
- retrieveTopology expands 1-hop neighbors
- retrieveTopology filters edges to selected nodes only
- retrieveTopology filters artifacts to selected nodes only
- retrieveTopology respects outputNodeLimit / outputEdgeLimit / outputArtifactLimit
- getStoredQueryTopologyFocus returns empty string for empty graph
- getStoredQueryTopologyFocus output JSON excludes internal scores
- RPC bridge prompt() passes text to maybeAutoCompactContext
- In-process bridge prompt() passes text to maybeAutoCompactContext
```

## 文件改动

| 文件 | 改动 |
|------|------|
| `apps/server/src/session-topology-retrieval.ts` | 新建 |
| `apps/server/src/session-topology-retrieval.test.ts` | 新建 |
| `apps/server/src/session-context.ts` | 新增 `getStoredQueryTopologyFocus()` |
| `apps/server/src/session-context.test.ts` | 新增 query focus 测试 |
| `apps/server/src/bridge/types.ts` | `SessionHandle.prompt` 已经是传 text，不需要改 |
| `apps/server/src/bridge/rpc.ts` | `maybeAutoCompactContext(query: string)` |
| `apps/server/src/bridge/in-process.ts` | `maybeAutoCompactContext(query: string)` |
| `apps/server/src/bridge/maybe-compact.test.ts` | 新建 (mock bridge, 验证透传) |

## 验证

```sh
bun test apps/server/src/session-topology-retrieval.test.ts \
         apps/server/src/session-context.test.ts \
         apps/server/src/bridge/maybe-compact.test.ts
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' build
```

## 不发

- importance / weight / confidence / relevance / metadata.reranker / createdAt

## 成功标准

1. 测试通过
2. typecheck / build 通过
3. 现有 `/api/stats/context-savings` 触发后，`recent[].focus` 是 topology JSON 且不含内部 score
4. 客户端行为不变
