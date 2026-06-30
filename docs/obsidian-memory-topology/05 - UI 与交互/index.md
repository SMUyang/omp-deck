# UI 与交互

## MemoryView

文件：`apps/web/src/views/MemoryView.tsx`

组件拆分：

| 组件 | 作用 |
|------|------|
| `MemoryView` | 页面容器，管理状态 |
| `StatusSection` | 顶部 backend/bank 概览 |
| `MemoryTopology` | Obsidian-style bank/store 概览 SVG |
| `BankTopologyNode` | 单个 bank 节点卡片 |
| `MemoryGraphPanel` | 图搜索与列表 |
| `MemoryGraphSvg` | 原生 SVG 图渲染 |
| `MemoryGraphNodeDetails` | 选中节点详情 |
| `MemoryCard` | 搜索结果卡片 |

## Topology 视觉设计

- v1 避免 Cytoscape / React Flow，使用原生 SVG。
- 中心：Mnemopi（聚合视角）。
- 卫星：各 bank 节点。
- 每个 bank 再展开 W/E/F/emb/G 卫星：
  - W = working
  - E = episodic
  - F = facts
  - emb = embeddings
  - G = graph edges
- 节点大小按 count 缩放。
- 点击 bank 过滤右侧列表。

## 路由与导航

- NavRail 增加 Brain 图标入口：`/memory`
- 路由注册于 `apps/web/src/router.tsx`
- i18n 支持：en + zh-CN

## 图渲染细节

- 节点：圆形 + 标签。
- 边：带 relation 标签的曲线/直线。
- 选中节点高亮，显示 inbound/outbound 度、content、importance。
- 图默认返回 120 节点；超过提示 truncated。

## 改造建议

v2 方向（未实现）：

- Neo4j Bloom 风格的 graph_edges 展开探索。
- 点击节点 recall 相关上下文。
- 批量选择节点生成 inbox task。
