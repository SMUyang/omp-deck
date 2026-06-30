# Memory Topology V2 Plan

## Goal
Validate current Memory Cockpit topology, then add v2 topology memory retrieval: query-backed subgraph data, topology search/expand UI, and reusable skill extraction.

## Current phase
Complete

## Phases

### Current effect
Status: complete
- [x] Smoke current topology UI
- [x] Record full suite status

### V2 design
Status: complete
- [x] Inspect memory graph schema
- [x] Inspect API and UI patterns
- [x] Define topology retrieval contract

### TDD implementation
Status: complete
- [x] Add failing topology API tests
- [x] Implement graph retrieval service
- [x] Wire topology API route
- [x] Add graph search UI tests if available (not available for views; verified by scout)
- [x] Implement topology retrieval UI

### Verification
Status: complete
- [x] Run targeted tests and typechecks
- [x] Smoke topology retrieval in browser
- [x] Request code review
- [x] Address review findings
- [x] Extract project memory-topology skill

## Decisions
- Keep v1 lightweight native SVG.
- V2 should expose query-bounded topology retrieval rather than rendering every memory/fact/edge.
- Avoid heavy graph libraries unless raw SVG becomes insufficient after real use.
- Follow TDD for new server behavior.

## Known issues
- Full `bun test` currently has 339 pass / 1 fail. Failure is `apps/server/src/orientation-store.test.ts` reading the real user start command; unrelated to memory topology but should be isolated separately.
