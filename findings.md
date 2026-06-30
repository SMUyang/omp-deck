# Memory Topology V2 Findings

## Current v1 smoke
- Browser `/memory` shows `MEMORY TOPOLOGY` and an `svg[role="img"]`.
- Bank click filter works: selecting `AI-1t3rbz2kwcq54` yielded 9 visible cards, all with that bank.
- Nav i18n fallback check passed: no raw `nav.memory` or `nav.settings` labels.
- Verification already observed: web typecheck clean; web build exit 0; memory-service test 5 pass / 0 fail.
- Full suite status: `bun test` has 334 pass / 1 fail. The failure is `apps/server/src/orientation-store.test.ts` reading the real user start command (`~/.omp/agent/commands/start.md`), unrelated to memory topology.

## Schema scout
- Mnemopi DBs are per-bank SQLite files under `~/.omp/agent/memories/mnemopi/`, including root-level `mnemopi.db` and `banks/<name>/mnemopi.db`.
- Existing server code is read-only in `apps/server/src/memory-service.ts`.
- Existing counted tables: `working_memory`, `episodic_memory`, `facts`, `memory_embeddings`, `graph_edges`.
- Test schema defines `working_memory` columns: `id`, `content`, `source`, `timestamp`, `importance`, `memory_type`, `recall_count`, `superseded_by`, `created_at`.
- `fts_working` is FTS5 over `working_memory`; search preserves FTS rank before importance sorting.
- `graph_edges` is counted only. Test stub defines only `id TEXT`, so real graph_edges columns are unknown and must be introspected before querying.
- Safe pattern: use try/catch around optional tables/columns so older schemas do not break `/memory`.

## API scout
- Memory routes live in `apps/server/src/routes-memory.ts` with existing `GET /memory/status` and `GET /memory/search`.
- New endpoint should be `GET /memory/graph` or `GET /memory/topology`; use same Hono sub-router.
- Protocol types belong in `packages/protocol/src/index.ts` after `MemorySearchResponse`.
- Web client methods live in `apps/web/src/lib/api.ts` using `request<T>()`.
- Closest graph response pattern is `KbGraphResponse` in protocol and `shapeGraphResponse()` in `apps/server/src/kb-service.ts`: nodes+edges with truncation flags.

## UI scout
- `apps/web/src/views/MemoryView.tsx` is currently a single-file view: `MemoryView`, `StatusSection`, `MemoryTopology`, `BankTopologyNode`, `MemoryCard`.
- No view tests exist under `apps/web/src/views`. Web package has no test script; existing web tests are limited to lib/components with `bun:test`.
- Existing rich graph UI reference is `apps/web/src/views/KbGraphPane.tsx`, using `react-force-graph-2d`; avoid reusing for v2 unless native SVG becomes insufficient.
- Minimal v2 UI: keep native SVG, add topology search query, selected node state, and bank expansion into graph nodes. Draw actual edges when server returns them.

## Skill extraction scout
- Project-specific skill should live under `<repo>/.omp/skills/memory-topology/`, not starter-skills.
- Reason: workflow is tightly coupled to omp-deck files and Mnemopi schema/API conventions.
- Skill content should cover memory-service graph retrieval, routes-memory endpoint, protocol types, MemoryView UI, and KB graph truncation pattern.
- Writing-skills requires skill TDD: pressure/baseline scenarios first, then write skill, then verify agents follow it. Do not directly add a new SKILL.md without test scenarios.

## V2 contract decision
- Endpoint: `GET /api/memory/graph?bank=&q=&limit=`.
- Server contract: return a bounded graph response with nodes, edges, totals, and truncation flag.
- Reliable v2.0 edge source: `working_memory.superseded_by` implicit edges.
- Conditional edge source: real `graph_edges`, only when introspection detects recognizable source/target columns.
- Query behavior: `q` filters seed nodes via existing FTS/LIKE behavior, then edges are constrained to included nodes for v2.0.
- Limit behavior: default bounded limit (candidate 120 nodes); no full-graph blast.
