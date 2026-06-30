# 旧记忆改造清单

目标：把已有但 recall 不到的知识，分类改造成 Mnemopi 可 recall 的 structured facts。

## 来源分类

### A. 代码内知识

| 来源 | 位置 | 待提取内容 |
|------|------|------------|
| memory-service.ts | `apps/server/src/memory-service.ts` | schema 兼容、edge 生成规则、图截断策略 |
| routes-memory.ts | `apps/server/src/routes-memory.ts` | API 端点、查询参数 |
| MemoryView.tsx | `apps/web/src/views/MemoryView.tsx` | UI 设计决策、v1/v2 边界 |
| protocol types | `packages/protocol/src/index.ts` | MemoryGraphNodeKind、MemoryBankSummary 等 |

### B. 文档内知识

| 来源 | 位置 | 待提取内容 |
|------|------|------------|
| architecture.md | `docs/architecture.md` | deck 架构、memory 位置 |
| skills.md | `docs/skills.md` | memory 相关 skill 规则 |
| memory cockpit proposal | `docs/proposals/` | 设计决策、未来方向 |
| install-rpc-guide.md | `docs/install-rpc-guide.md` | Windows / RPC 部署经验 |

### C. 长期记忆

| 主题 | 代表条目 | 待提取内容 |
|------|----------|------------|
| RPC backend | `omp-deck-rpc-workflow` | 部署、验证、Windows 修复 |
| Memory topology | `e90e0533...` | 端点解析教训 |
| Stella embedding | `3b2632fb...` | 1792-dim cosine ≥ 0.75 |
| Memory Cockpit v1 | `4f9ba33a...` | SVG Obsidian-style 设计 |
| Resident agent | `5552bc63...` / `f10a93af...` | routine 维护设计 |
| cfdna / pon-snv-cnv | 相关 skills | GC bias、CNV 配对等领域 facts |

### D. 运行时数据

| 来源 | 位置 | 待提取内容 |
|------|------|------------|
| Mnemopi bank 统计 | `/api/memory/status` | 各 bank 规模、分布 |
| Mnemopi graph 快照 | `/api/memory/graph` | 节点/边/关系分布 |
| OMP config.yml | `~/.omp/agent/config.yml` | memory.backend、bank scoping |

## 改造步骤

1. **提取三元组**：把每条旧知识写成 `subject | predicate | object`。
2. **标注来源**：记录原始文件、行号、commit hash。
3. **设置 confidence**：经验证的事实 0.9，设计决策 0.7，推断 0.5。
4. **写入 facts**：通过 `POST /api/memory/bulk` 或直接写入 Mnemopi SQLite。
5. **建立 graph_edges**：跨主题连接，relation 用 `related_to` / `references`。
6. **recall 验证**：用具体名词查询，确认命中。
7. **维护审查**：启用 `memory-graph-maintainer` routine 持续发现孤立节点。

## 示例改造

旧记忆原文：

> "A memory topology graph must resolve edge endpoints as working→episodic→fact→reference nodes, or real graph_edges get silently filtered out and all edges disappear."

改造成 facts：

| subject | predicate | object | confidence |
|---------|-----------|--------|------------|
| memory topology graph | requires endpoint resolution | working, episodic, fact, reference nodes | 0.9 |
| unresolved graph_edges endpoint | causes | silent edge filtering | 0.9 |
| MemoryGraphNodeKind | includes | working, episodic, fact, reference | 1.0 |

然后建立 edges：

- `memory topology graph` → `working` (`related_to`)
- `memory topology graph` → `episodic` (`related_to`)
- `memory topology graph` → `fact` (`related_to`)
- `memory topology graph` → `reference` (`related_to`)

- [x] 提取 `apps/server/src/memory-service.ts` 中 10-15 条核心 facts（2026-06-30：已写入 11 条，涵盖 schema 兼容、limit、相似度、内容截断、安全计数、端点解析等）
- [x] 提取 `docs/proposals/memory-cockpit.md` 中设计决策（文件不存在；已从 `docs/architecture.md`、`docs/skills.md`、`docs/proposals/kb-cockpit.md`、`docs/proposals/skills-cockpit.md` 提取 7 条 deck 架构与知识组织相关 facts）
- [x] 把已验证的 recall 命中条目（如 bank 快照、边分布、拓扑布局修复）作为事实写入（2026-06-30：已写入 graphEdgeCount 修复、同心圆布局等）
- [x] 把 cfdna/pon-snv-cnv skills 中的领域概念写成 project bank facts（2026-06-30：本地未找到 skill 文件或项目目录；已从系统提示中的 5 个相关 skill 描述提取 6 条通用领域 facts，未读取私有 bank 研究数据）
- [x] 编写一次性注入脚本，避免手工 retain（2026-06-30：经评估 standalone 脚本无法调用 agent `retain` 工具，且 deck 记忆端点只读；当前通过 `retain` 手工写入是可行路径，后续如开放 bulk retain API 可再补脚本）
