# Memory Topology 知识库索引

本 vault 汇总 omp-deck Memory Cockpit 与 OMP Mnemopi 后端的拓扑/记忆知识，用于把旧记忆改造成可 recall 的结构化 facts。

## 分类目录

1. [[01 - 概念与实体/index|概念与实体]] — MemoryBackendId、bank、node kind、reference node。
2. [[02 - 模式与表结构/index|模式与表结构]] — SQLite 表、FTS、embedding_json。
3. [[03 - 边类型与权重/index|边类型与权重]] — graph_edges 关系、derived edges、权重规则。
4. [[04 - 服务与 API/index|服务与 API]] — memory-service、routes-memory、REST 端点。
5. [[05 - UI 与交互/index|UI 与交互]] — MemoryView、SVG topology、bank filtering。
6. [[06 - 常驻维护/index|常驻维护]] — memory-graph-maintainer routine。
7. [[07 - 旧记忆改造清单/index|旧记忆改造清单]] — 待提取的旧记忆来源与任务。

## 核心数字（2026-06-30 快照）

- Bank: `AI-1t3rbz2kwcq54`（默认聚合视角）
- 总节点：500（working 132 / episodic 41 / reference 32 / fact 295）
- 总边：2350
- 边分布：`similar` 1153 / `ctx` 443 / `related_to` 321 / `extracted_from` 295 / `summarizes` 92 / `same_session` 25 / `references` 18 / `rel` 3

## 关键设计决策

- 默认使用外部 `omp --mode rpc` 后端，不依赖嵌入 SDK。
- Memory Cockpit v1 用原生 SVG，避免 Cytoscape/React Flow。
- 常驻维护使用现有 routine 系统，而非新建持久进程。
- Edge 计算基于 Stella 1792 维 embedding cosine ≥ 0.75。

- `3498942` Add Memory Cockpit v1: status, search, and topology overview
- `3498942+` Fix topology bank node sizing to include `graphEdgeCount`; switch bank satellites to outward-facing concentric arcs with faint orbit rings
- `d390bf5+` Extract architecture, skills, and cfdna/pon-snv-cnv domain facts into Mnemopi structured memories; complete transformation checklist
