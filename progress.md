# Memory Topology V2 Progress

## 2026-06-30

- Verified current v1 topology UI in browser: topology heading, SVG, bank filter, and nav i18n fallback checks.
- Ran full `bun test`: 334 pass / 1 fail. Failure is orientation-store environment leakage from real start command.
- Started v2 topology retrieval work.
- Dispatched parallel read-only scouts for schema, API, UI, and skill extraction.
- Captured findings in `findings.md`.
- Selected v2 contract: `GET /api/memory/graph?bank=&q=&limit=` returning bounded memory graph data. Reliable initial edge source is `working_memory.superseded_by`; real `graph_edges` is conditional on schema introspection.
- Added `MemoryGraphResponse` protocol types and `getMemoryGraph()` service.
- Added `GET /api/memory/graph` route and web API client method.
- Added native SVG graph retrieval panel in `MemoryView.tsx` with submitted topology search, selected-node details, and stale response guard.
- Added project skill `.omp/skills/memory-topology/SKILL.md` and verified it with a read-only pressure scenario.
- Code review found unbounded edge loads and per-keystroke API calls; fixed by capping `graph_edges` query and switching graph search to Enter/button submit.
- Fresh targeted checks after checklist completion: memory-service tests 16 pass / 0 fail; server typecheck clean; web typecheck clean; web build exit 0; browser smoke confirmed overview topology renders with 2 SVGs, graph counts render, topology search changes graph results after Enter, and no `nav.memory`/`nav.settings` fallback labels.
- Fresh full `bun test`: 348 pass / 1 fail; remaining failure is still `apps/server/src/orientation-store.test.ts` reading the real user start command from `~/.omp/agent/commands/start.md`, unrelated to memory topology.
