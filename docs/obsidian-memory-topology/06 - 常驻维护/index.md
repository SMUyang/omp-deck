# 常驻维护

## memory-graph-maintainer

文件：`apps/server/src/templates/memory-graph-maintainer.yaml`

设计决策：使用 omp-deck 现有 routine 系统，而非新建持久进程。

## Routine 流程

```yaml
trigger:
  - cron: "*/30 * * * *"
concurrency: skip
budget:
  max_duration_secs: 180
  max_llm_cost_usd: 0.02
```

步骤：

1. **fetch_status** — `GET /api/memory/status`
2. **fetch_graph** — `GET /api/memory/graph?limit=120`
3. **compute_stats** — transform 计算：
   - 节点数、边数、孤立节点数
   - 按 relation 统计边分布
   - 图 signature（用于跳过无变化图）
   - 前 20 重要节点
4. **analyze** — agent LLM 审查：
   - 断连集群
   - 孤立高重要度节点
   - 缺失语义连接
   - 边权重异常
5. **write_report** — `deck.create_inbox_item` 写入报告
6. **persist_state** — 保存 signature 避免重复分析

## 启用方式

该 routine 默认 `enabled: false`，需在 deck UI / routines 页面手动启用。

## 改造建议

当批量注入旧记忆后，可扩展该 routine：

- 检测新注入 facts 的连通性。
- 建议跨 bank 连接。
- 把孤立的重要旧记忆写入 inbox 提醒。
