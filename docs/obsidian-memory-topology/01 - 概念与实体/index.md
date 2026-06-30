# 概念与实体

## MemoryBackendId

OMP 支持的记忆后端类型（来自 `packages/protocol/src/index.ts:1755`）：

```ts
export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi";
```

| 后端 | 说明 |
|------|------|
| off | 关闭 |
| local | 本地 rollout summary，无语义搜索 |
| hindsight | 远程 HTTP 后端 |
| mnemopi | 本地 SQLite + embedding + recall/retain/forget/invalidate |

实际通过 OMP `~/.omp/agent/config.yml` 的 `memory.backend` 设置。

## Bank（记忆库）

Mnemopi 数据存储在 `~/.omp/agent/memories/mnemopi/banks/<bank-id>/mnemopi.db`。

- 默认 shared bank：`default`
- 按项目 bank：从 `cwd` 派生，例如 `omp-deck-2t2dj37r4n4gj`
- `per-project-tagged`：同时打开 project bank 和 shared bank，合并 recall 结果，但写入 project-local

已知 bank（2026-06-30）：

| Bank | 特点 |
|------|------|
| AI-1t3rbz2kwcq54 | 默认聚合视角，节点 500，边 2350 |
| PON_SNV_CNV_Analysis-31yzniozw8lrt | 最大事实源，570 facts |
| omp-deck-2t2dj37r4n4gj | graph_edges 最多，213 |
| NIKKEAutoScript-3saxi3s38zco4 | 空 bank |
| printer-3d7wae0ilxfvx, tmp-1tpw73408x3e, Luker-16f2dyw518151, macsetting-np08pd12kvti | 其他项目 bank |

## Node Kind

Memory Cockpit 图节点类型（`packages/protocol/src/index.ts:1800`）：

```ts
export type MemoryGraphNodeKind = "working" | "episodic" | "fact" | "reference";
```

| Kind | 来源表 | 说明 |
|------|--------|------|
| working | `working_memory` | 会话级工作记忆 |
| episodic | `episodic_memory` | 情节/摘要记忆 |
| fact | `facts` | 提取的三元组/事实 |
| reference | `reference_nodes` / gist | 引用节点 |

## Reference Node

Reference node 是跨表端点的占位。`memory-service.ts` 中 `resolveEndpointNode` 会先从 `workingRows` 查找，找不到则创建一个最小 reference node，避免 graph edge 因端点缺失被过滤。

> 关键教训：必须把工作记忆、情节记忆、事实、引用节点统一视作端点，否则 `graph_edges` 真实边会静默消失。

## Embedding

- 模型：Stella 1792 维
- 存储：`memory_embeddings.embedding_json`
- 相似度：cosine ≥ 0.75 生成 `similar` 边
- deck 的 `memory-service.ts` 中也实现了本地 `cosineSimilarity`，可处理不同长度向量
