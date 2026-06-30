---
name: memory-topology
description: Use when modifying omp-deck Memory Cockpit topology, Mnemopi graph retrieval, /memory graph APIs, or topology search UI.
---

# Memory Topology

Use for omp-deck's Memory Cockpit topology work.

## Hard constraints

- Keep v1/v2 UI lightweight: native SVG in `apps/web/src/views/MemoryView.tsx`.
- Do not add Cytoscape, React Flow, or new graph libraries unless the user explicitly asks or measured browser smoke proves native SVG is insufficient.
- Server access is read-only. All memory mutation stays in OMP/Mnemopi slash-command flows.
- Treat Mnemopi SQLite schemas as versioned/optional. Use safe table/column introspection and degrade gracefully.
- Use TDD for server behavior: write `apps/server/src/memory-service.test.ts` cases before production changes.

## Files

| Layer | Files |
|---|---|
| Protocol | `packages/protocol/src/index.ts` |
| Server service | `apps/server/src/memory-service.ts` |
| Server route | `apps/server/src/routes-memory.ts` |
| Web API | `apps/web/src/lib/api.ts` |
| Web UI | `apps/web/src/views/MemoryView.tsx`, `apps/web/src/i18n/index.ts` |
| Reference graph pattern | `apps/server/src/kb-service.ts` `shapeGraphResponse()` and protocol `KbGraphResponse` |

## Current graph contract

- Endpoint: `GET /api/memory/graph?bank=&q=&limit=`.
- Response type: `MemoryGraphResponse` with `query`, optional `bank`, `nodes`, `edges`, `totalNodes`, `truncated`.
- Default bounded response: no full-graph blast. Clamp node and edge rows to safe maximums in the service.
- Reliable node source: `working_memory` rows.
- Endpoint node source: graph_edges endpoints resolved to `episodic_memory`, `facts`, or `reference` nodes, so cross-store edges survive.
- Reliable edge source: `working_memory.superseded_by` as `relation: "supersedes"`, `weight: 1`.
- Conditional edge source: `graph_edges`, only when introspection finds recognizable source and target columns.
- Edges carry `weight` when the table exposes it; UI scales stroke width by weight.

## Schema rules

Known `working_memory` columns from tests:

- `id`, `content`, `source`, `timestamp`, `importance`, `memory_type`, `recall_count`, `superseded_by`, `created_at`

Known counted tables:

- `working_memory`
- `episodic_memory`
- `facts`
- `memory_embeddings`
- `graph_edges`

`graph_edges` columns are not stable in this repo's fixtures. Never hardcode one schema only. Probe with `PRAGMA table_info("graph_edges")` and support common aliases:

- source: `source_id`, `source`, `from_id`, `from`, `src`
- target: `target_id`, `target`, `to_id`, `to`, `dst`
- relation: `relationship`, `relation`, `type`, `edge_type`, `label`
- weight: `weight`, `score`, `strength`
Observed real Mnemopi `graph_edges`: `source`, `target`, `edge_type`, `weight REAL DEFAULT 1.0`. Tests use both `source_id`/`relationship` and the real schema, so keep aliases.

Missing graph edge columns means return no graph_edges-derived edges, not an error.

## Implementation sequence

1. Add/adjust protocol types.
2. Add failing `memory-service.test.ts` coverage:
   - working-memory nodes
   - `superseded_by` edge
   - bank filter
   - query filter
   - truncation
   - optional `graph_edges` source/target/relation columns
   - `graph_edges` cap before filtering
3. Implement in `memory-service.ts` with read-only DB handles and safe try/catch around optional tables.
4. Wire `routes-memory.ts` and `apps/web/src/lib/api.ts`.
5. Extend `MemoryView.tsx` without replacing the overview topology.
6. Guard async graph searches against stale response races.
7. Do not fire graph API calls on every keystroke; use Enter/button submit or debounce plus stale-response guard.
8. Add i18n keys in both `en` and `zh-CN`; keep `nav.memory` and `nav.settings` nested inside `nav`.

## Verification

Run:

```sh
bun test apps/server/src/memory-service.test.ts
bunx tsc --noEmit  # from apps/server
bunx tsc --noEmit  # from apps/web
bun run --filter '@omp-deck/web' build
```

Browser smoke `/memory`:

- Overview topology still renders.
- Graph retrieval panel shows node/edge counts.
- `Search topology nodes…` filters graph nodes after Enter/button submit.
- Clicking a graph node shows selected-node details.
- No raw `nav.memory` or `nav.settings` fallback labels.

## Common failures

- Querying `graph_edges.source_id` directly without introspection breaks older DBs.
- Rendering all memories/facts/edges creates a hairball; always bound `limit`.
- Replacing v1 bank/store overview loses useful status context; add v2 retrieval beside it.
- Search-on-change can create SQLite request storms; use Enter/button submit or debounce, plus a request sequence guard.
- Adding English i18n only breaks Chinese UI.
