# Session Context Topology Conversation Node Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed Session Context Topology node pool with user/assistant conversation pairs plus assistant-owned test, subagent, task, tool-evidence, and error children, then retrieve complete pairs over the full session without the global 500-node pre-cut.

**Architecture:** Add backward-compatible semantic columns and an `answers` relation, normalize the active JSONL branch into deterministic conversation events, build one user main node and one final assistant main node per pair, attach structured child nodes to the assistant, and retrieve pair units from the complete eligible graph. Keep deterministic purpose fields authoritative; optional model refinement is additive and provenance-labeled. Model-facing focus moves to schema v2 pair payloads while existing graph/pack APIs and v1 parsing remain compatible during migration.

**Tech Stack:** TypeScript, Bun test, Hono, SQLite migrations, OMP session JSONL, Stella embeddings, SiliconFlow rerank adapter, React.

**Approved design:** `docs/superpowers/specs/2026-07-31-session-topology-conversation-node-redesign.md`

---

## File Structure

### New focused modules

- `apps/server/src/session-context-events.ts` — parse JSONL entries, resolve the active parent chain, normalize roles/content/tool lifecycle data, and expose deterministic event primitives.
- `apps/server/src/session-context-events.test.ts` — branch, synthetic-user, stop-reason, timestamp, and exact tool-ID normalization tests.
- `apps/server/src/session-context-pairs.ts` — build user/assistant main nodes, assistant children, artifacts, pair IDs, parent IDs, and structural edges from normalized events.
- `apps/server/src/session-context-pairs.test.ts` — pair boundaries, operation/purpose mapping, child extraction, status, artifact ownership, and stable-ID tests.
- `apps/server/src/session-pair-retrieval.ts` — complete-graph population lanes, field-aware scoring, pair closure, child expansion, and output-budget reconciliation.
- `apps/server/src/session-pair-retrieval.test.ts` — early-user eligibility, pair/child closure, population floors, child limits, rerank closure, and long-session regressions.
- `apps/server/src/db/migrations/010-session-context-node-semantics.sql` — additive node semantic columns and extraction checkpoint version.
- `apps/server/src/db/migrations/011-session-context-edge-answers.sql` — transactional edge-table rebuild adding `answers` to the checked relation set.

### Existing modules to modify

- `packages/protocol/src/index.ts` — v2 node fields, operation/status types, `answers` relation, checkpoint version, and v2 focus types.
- `apps/server/src/db/session-context.ts` — persist/read v2 fields, refinement provenance, checkpoint version, complete graph access, batched pair/child edge access, and embedding invalidation.
- `apps/server/src/session-context.ts` — orchestrate v2 extraction/rebuild, keep legacy pack compatibility, use pair retrieval, and render v2 focus.
- `apps/server/src/session-topology-retrieval.ts` — retain legacy retrieval for v1 compatibility only; remove it from v2 focus orchestration.
- `apps/server/src/topology-extractor.ts` — restrict optional refinement to `operationDetail`/`refinedPurpose` and provenance; never mutate deterministic structure.
- `apps/server/src/topology-reranker.ts` — sanitized pair candidate contract and post-patch closure validation.
- `apps/server/src/topology-rerank-siliconflow-adapter.ts` — pair-document construction and pair-ID result mapping.
- `apps/server/src/routes-session-context.ts` — whole-graph totals and v2 focus response semantics.
- `apps/server/src/bridge/auto-rebuild.ts` — extraction-version staleness and v2 rebuild trigger.
- `apps/server/src/session-context.test.ts`, `apps/server/src/db/session-context.test.ts`, `apps/server/src/routes-session-context.test.ts`, `apps/server/src/topology-reranker.test.ts`, `apps/server/src/topology-rerank-siliconflow-adapter.test.ts`, `apps/server/src/bridge/auto-rebuild.test.ts` — compatibility/integration coverage.
- `apps/web/src/lib/topology-focus.ts` and test — parse schema v1 and v2 focus.
- `apps/web/src/components/session/TopologyGraph.tsx` and tests — user/assistant population lanes with nested assistant children.
- `apps/web/src/views/TopologyView.tsx` — inspect operation, purpose, status, pair, parent, and origin while keeping diagnostic scores local to the UI.

---

### Task 1: Protocol and SQLite compatibility foundation

**Files:**
- Modify: `packages/protocol/src/index.ts:1974-2115`
- Create: `apps/server/src/db/migrations/010-session-context-node-semantics.sql`
- Create: `apps/server/src/db/migrations/011-session-context-edge-answers.sql`
- Modify: `apps/server/src/db/session-context.ts`
- Modify: `apps/server/src/db/session-context.test.ts`
- Modify: `apps/server/src/db/migrations-context-evidence.test.ts`

- [ ] **Step 1: Write failing protocol/store tests for v2 semantic round-trip**

Add a v2 node fixture to `apps/server/src/db/session-context.test.ts`:

```ts
const v2Node: SessionContextNode = {
  id: "s1:entry:u1:message",
  sessionId: "s1",
  kind: "goal",
  title: "Keep start mode alive",
  body: "start mode must remain alive in the background",
  compressedBody: "start mode must remain alive in the background",
  importance: 0.7,
  createdAt: "2026-07-31T00:00:00.000Z",
  sourceMessageId: "u1",
  sourceTurnIndex: 1,
  population: "user",
  nodeRole: "main",
  origin: "user",
  pairId: "s1:pair:u1",
  operation: "request",
  operationDetail: "fix_background_start",
  purpose: "让 start 模式保持后台运行",
  purposeSource: "explicit_text",
  refinedPurpose: "确保后台服务持续存活",
  refinement: { model: "fast/model", promptVersion: "purpose-v1" },
  status: "completed",
  metadata: {},
};
```

Assert both `replaceSessionContext()` and `insertSessionContextNodes()` round-trip every new field, including `refinement`.

Add an edge fixture:

```ts
{
  id: "s1:answers:a1:u1",
  sessionId: "s1",
  sourceNodeId: "a1",
  targetNodeId: "u1",
  relation: "answers",
  weight: 1,
  evidenceMessageId: "a1",
  metadata: {},
}
```

Assert it survives storage and retrieval.


Add migration inventory/schema assertions to `apps/server/src/db/migrations-context-evidence.test.ts`: verify both new migration filenames are applied, all semantic/checkpoint columns exist, the edge relation `CHECK` accepts `answers`, all ten legacy relation values still insert, copied pre-migration edge rows survive, and the three edge indexes exist after the table rebuild.
- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test apps/server/src/db/session-context.test.ts apps/server/src/db/migrations-context-evidence.test.ts
```

Expected failures: protocol/store tests fail because v2 fields are missing; migration tests fail because migrations 010/011, semantic columns, `answers` acceptance, copied-row preservation, and recreated edge indexes do not exist.

- [ ] **Step 3: Add protocol types and optional node fields**

Add these protocol declarations adjacent to `SessionContextNodeKind`:

```ts
export type SessionContextPopulation = "user" | "assistant";
export type SessionContextNodeRole = "main" | "child";
export type SessionContextNodeOrigin = "user" | "assistant" | "tool" | "subagent" | "task";
export type SessionContextChildType = "test" | "subagent_result" | "task_state" | "tool_evidence" | "error";
export type SessionContextOperation =
  | "ask" | "request" | "provide" | "correct" | "constrain"
  | "approve" | "reject" | "report" | "answer" | "plan"
  | "investigate" | "implement" | "modify" | "verify" | "explain"
  | "summarize" | "delegate" | "track" | "observe" | "unknown";
export type SessionContextPurposeSource = "explicit_text" | "structured_intent" | "deterministic" | "unclassified";
export type SessionContextNodeStatus = "pending" | "completed" | "failed" | "blocked" | "aborted" | "unknown";
export interface SessionContextRefinementProvenance { model: string; promptVersion: string; }
```

Extend `SessionContextNode` with the optional properties from the design. Add `"answers"` to `SessionContextEdgeRelation`. Extend checkpoint/status protocol types with optional `extractionSchemaVersion`.

- [ ] **Step 4: Add migrations**

Create `010-session-context-node-semantics.sql` with additive nullable columns and checkpoint version:

```sql
ALTER TABLE session_context_nodes ADD COLUMN population TEXT;
ALTER TABLE session_context_nodes ADD COLUMN node_role TEXT;
ALTER TABLE session_context_nodes ADD COLUMN origin TEXT;
ALTER TABLE session_context_nodes ADD COLUMN child_type TEXT;
ALTER TABLE session_context_nodes ADD COLUMN pair_id TEXT;
ALTER TABLE session_context_nodes ADD COLUMN parent_node_id TEXT;
ALTER TABLE session_context_nodes ADD COLUMN operation TEXT;
ALTER TABLE session_context_nodes ADD COLUMN operation_detail TEXT;
ALTER TABLE session_context_nodes ADD COLUMN purpose TEXT;
ALTER TABLE session_context_nodes ADD COLUMN purpose_source TEXT;
ALTER TABLE session_context_nodes ADD COLUMN refined_purpose TEXT;
ALTER TABLE session_context_nodes ADD COLUMN refinement_json TEXT;
ALTER TABLE session_context_nodes ADD COLUMN status TEXT;
ALTER TABLE session_context_checkpoints ADD COLUMN extraction_schema_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_population_role
  ON session_context_nodes(session_id, population, node_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_pair
  ON session_context_nodes(session_id, pair_id);
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_parent
  ON session_context_nodes(parent_node_id);
```

Create `011-session-context-edge-answers.sql` using an explicit temporary-table copy. The new `CHECK` contains every existing relation plus `answers`; copy all columns explicitly, drop old table, rename, and recreate `idx_session_context_edges_session`, `_source`, and `_target`.

- [ ] **Step 5: Update DB mappings and checkpoint version**

Add nullable fields to `NodeRow`; validate enum-like strings with small type guards in `nodeFromRow()`. Parse `refinement_json` only when it is an object containing string `model` and `promptVersion`. Bind every new column in both node insert paths. Add `extraction_schema_version` to checkpoint read/write types and SQL.

Add:

```ts
export const SESSION_CONTEXT_EXTRACTION_SCHEMA_VERSION = 2;
```

in the server context domain and persist it on rebuild.

- [ ] **Step 6: Add complete-graph DB read API without pre-cut**

Keep `getSessionContextGraph(sessionId, limit)` for existing diagnostic/legacy callers. Add:

```ts
export function getCompleteSessionContextGraph(sessionId: string): SessionContextGraphResponse
```

It selects all nodes for the session in stable `source_turn_index, created_at, id` order, all edges, and all artifacts. It must not allocate a second body copy or pre-sort by importance. Return `truncated: false` and authoritative `totalNodes`.

Add a test with 650 late evidence nodes plus one early user node and assert the complete API returns all 651 nodes and all connected edges while the legacy bounded API remains bounded.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
bun test apps/server/src/db/session-context.test.ts apps/server/src/db/migrations-context-evidence.test.ts
bun run --filter '@omp-deck/protocol' typecheck
bun run --filter '@omp-deck/server' typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/protocol/src/index.ts apps/server/src/db/migrations/010-session-context-node-semantics.sql apps/server/src/db/migrations/011-session-context-edge-answers.sql apps/server/src/db/session-context.ts apps/server/src/db/session-context.test.ts apps/server/src/db/migrations-context-evidence.test.ts
git commit -m "feat: add conversational topology storage schema"
```

---

### Task 2: Branch-aware transcript normalization

**Files:**
- Create: `apps/server/src/session-context-events.ts`
- Create: `apps/server/src/session-context-events.test.ts`
- Modify: `apps/server/src/session-context.ts` — import and call the normalizer during v2 rebuild integration in Task 3; Task 2 itself does not modify this file

- [ ] **Step 1: Write failing active-branch and role-normalization tests**

Define wished-for API:

```ts
export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  intent?: string;
  sourceEntryId: string;
  lifecycleStartedAt?: string;
  lifecycleMetadata: Record<string, unknown>;
}

export interface NormalizedToolResult {
  toolCallId: string;
  toolName?: string;
  text: string;
  details?: unknown;
  isError: boolean;
  prunedAt?: string;
  sourceEntryId: string;
  lifecycleEndedAt?: string;
  metadata: Record<string, unknown>;
}

export interface NormalizedSessionEvent {
  entryId: string;
  parentId?: string;
  sourceLine: number;
  sourceTimestamp?: string;
  sdkTimestampMs?: number;
  role: "user" | "assistant" | "developer" | "system" | "tool" | "unknown";
  synthetic: boolean;
  text: string;
  stopReason?: string;
  toolCalls: NormalizedToolCall[];
  toolResult?: NormalizedToolResult;
  customType?: string;
  metadata: Record<string, unknown>;
}

export function normalizeSessionJsonl(input: { content: string }): {
  activeEvents: NormalizedSessionEvent[];
  diagnostics: Array<{ line: number; code: string }>;
};
```

Tests must cover:

1. abandoned physical branch excluded by `parentId` traversal;
2. genuine user retained;
3. `synthetic:true` user normalized as system/control, never genuine user;
4. developer/custom/advisor events never open a user pair;
5. assistant text excludes thinking blocks while preserving all tool-call blocks;
6. exact `toolCallId`, `toolName`, `arguments`, `intent`, `isError`, `details`, `prunedAt` retained;
7. malformed lines add diagnostics without shifting stable entry identity;
8. timestamp prefers valid record ISO, retains SDK ms as provenance, marks mismatch, never uses `Date.now()`.

- [ ] **Step 2: Run the new test and verify RED**

```bash
bun test apps/server/src/session-context-events.test.ts
```

Expected: module/API missing.

- [ ] **Step 3: Implement lenient JSONL parsing and active-chain selection**

Parse every line into an indexed entry. Select the active leaf by walking backward from the last valid entry whose `id` exists, then follow `parentId` to the root. Preserve selected events in root-to-leaf order. If a referenced parent is missing, stop traversal at that entry, record `{ line, code: "missing_parent" }`, and return only the reachable suffix; do not scan abandoned siblings.

Use stable IDs from source entry IDs. For entries without IDs, compute `sha256(canonicalJson(record))` and use `line-<lineNumber>-<first16hex>`.

- [ ] **Step 4: Implement structured message normalization**

Inspect the full message envelope before flattening text. Preserve only assistant `text` blocks in `text`; ignore thinking/redactedThinking for topology content. Parse tool calls separately. Normalize `toolResult` and legacy `tool` roles without proximity pairing.

Map `custom_message` to system/control metadata and `custom` tool lifecycle records to enrichment events. Do not promote them to conversational events.

- [ ] **Step 5: Run focused tests**

```bash
bun test apps/server/src/session-context-events.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/server/src/session-context-events.ts apps/server/src/session-context-events.test.ts apps/server/src/session-context.ts
git commit -m "feat: normalize active session branch events"
```

---

### Task 3: Deterministic conversation pairs and assistant children

**Files:**
- Create: `apps/server/src/session-context-pairs.ts`
- Create: `apps/server/src/session-context-pairs.test.ts`
- Modify: `apps/server/src/session-context.ts`
- Modify: `apps/server/src/session-context.test.ts`
- Modify: `apps/server/src/topology-extractor.ts`
- Modify: `apps/server/src/topology-extractor.test.ts`

- [ ] **Step 1: Write failing pair and stable-ID tests**

Define:

```ts
export function buildConversationTopology(input: {
  sessionId: string;
  events: NormalizedSessionEvent[];
}): ExtractedSessionContext;
```

Tests:

- simple user → assistant final creates two main nodes, same `pairId`, and `assistant --answers--> user`;
- user → assistant `toolUse` → two out-of-order results → final assistant still creates exactly two main nodes;
- adjacent user messages leave the first unanswered;
- aborted/tool-only pair has no assistant final node or `answers` edge;
- stable node IDs remain unchanged when operation detail/refinement changes;
- user operation mapping and deterministic purpose are populated from explicit text;
- absent purpose yields `purpose=null`, `purposeSource=unclassified`.
- historical missing-stop-reason fallback produces an assistant candidate-final node with `status="unknown"` and provenance such as `metadata.answerBoundarySource="missing_stop_reason_fallback"`;

Use explicit expected IDs:

```ts
expect(user.id).toBe("s1:entry:u1:message");
expect(answer.id).toBe("s1:entry:a1:message");
expect(user.pairId).toBe("s1:pair:u1");
expect(unknownStopAnswer.status).toBe("unknown");
expect(unknownStopAnswer.metadata.answerBoundarySource).toBe("missing_stop_reason_fallback");
```

- [ ] **Step 2: Run pair tests and verify RED**

```bash
bun test apps/server/src/session-context-pairs.test.ts
```

Expected: module/API missing.

- [ ] **Step 3: Implement main pair construction**

Each genuine user event opens `PairBuilder`. Intermediate assistant/tool/system events attach to it. Final assistant text closes it. Map user operations deterministically with the approved applicability table; map assistant operations from final answer structure and completed structured actions. Unknown mappings remain `unknown`, never guessed by keyword adjacency.

Retain legacy `kind` for compatibility:

- user main: `goal` or explicit correction `user_intent`;
- assistant main: `resolution` for implemented/fixed output, `decision` for plan/answer decisions, otherwise `action`.

Do not create legacy `continues`, proximity `depends_on`, or proximity `verified_by` edges in v2.

- [ ] **Step 4: Write failing child-node tests**

Add tests for:

- structured test command/result → one `test` child containing bounded command, pass/fail counts, exit code, and duration;
- successful read containing “error” → non-error tool evidence;
- `isError=true` or nonzero exit code → one `error` child;
- subagent lifecycle chatter + final result → one `subagent_result` child containing safe agent identity, delegated target, conclusion, and whether it mutated files;
- repeated task state transitions → one latest `task_state` child per stable task text/identity;
- skipped, queued, superseded, empty, poll/status, cancelled-before-execution, and repetitive-log outputs → hidden provenance, no child;
- duplicate tool names pair by exact call ID;
- files, commits, URLs, images, and generated assets attach as artifacts to the owning assistant/child.

- [ ] **Step 5: Implement child extraction and parent ownership**

Child IDs use stable structured identifiers:

```ts
`${sessionId}:pair:${promptId}:tool:${toolCallId}`
`${sessionId}:pair:${promptId}:agent:${agentId}`
`${sessionId}:pair:${promptId}:task:${stableTaskHash}`
```

Set `population=assistant`, `nodeRole=child`, `origin` to actual source, `parentNodeId` to assistant final ID, and the appropriate `childType`.

- [ ] **Step 6: Integrate v2 extraction into rebuild**

In `rebuildSessionContextFromFile()`, call:

```ts
const normalized = normalizeSessionJsonl({ content });
const extracted = buildConversationTopology({ sessionId, events: normalized.activeEvents });
```

Remove the old regex/proximity extraction from the v2 rebuild path but keep a compatibility-only exported legacy function until all old tests/callers are migrated. Persist extraction schema version 2.

- [ ] **Step 7: Restrict optional model refinement**

Change the refiner contract so it can return only:

```ts
{ id, operationDetail?, refinedPurpose? }
```

Validate IDs against deterministic nodes. Preserve all structure/status/source fields. Record `refinement={model,promptVersion}` only for accepted changes. A failure returns the deterministic node list unchanged.

The optional model semantic layer for legacy relations is outside this implementation's production extraction path. Task 3 must preserve legacy relation rows on unreconstructed v1 graphs and prove that a v2 rebuild emits no proximity-derived legacy relations. A later separately approved feature may add model-derived semantic edges with provenance; this plan must not silently implement them.

- [ ] **Step 8: Run extraction tests**

```bash
bun test apps/server/src/session-context-events.test.ts \
  apps/server/src/session-context-pairs.test.ts \
  apps/server/src/session-context.test.ts \
  apps/server/src/topology-extractor.test.ts
```

Expected: all pass.

- [ ] **Step 9: Commit Task 3**

```bash
git add apps/server/src/session-context-pairs.ts apps/server/src/session-context-pairs.test.ts apps/server/src/session-context.ts apps/server/src/session-context.test.ts apps/server/src/topology-extractor.ts apps/server/src/topology-extractor.test.ts
git commit -m "feat: extract conversational topology pairs"
```

---

### Task 4: Extraction-version auto-rebuild and historical compatibility

**Files:**
- Modify: `apps/server/src/bridge/auto-rebuild.ts`
- Modify: `apps/server/src/bridge/auto-rebuild.test.ts`
- Modify: `apps/server/src/routes-session-context.ts`
- Modify: `apps/server/src/routes-session-context.test.ts`

- [ ] **Step 1: Write failing staleness tests**

Add tests proving:

- same file mtime/size with checkpoint version 1 is stale under server version 2;
- same file mtime/size with version 2 is fresh;
- historical `POST /context/rebuild` returns version 2 status;
- v1 rows remain readable before rebuild.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bun test apps/server/src/bridge/auto-rebuild.test.ts apps/server/src/routes-session-context.test.ts
```

Expected: checkpoint version is ignored/missing.

- [ ] **Step 3: Implement version-aware staleness**

Make `isCheckpointFresh` require matching mtime, size, and `extractionSchemaVersion >= SESSION_CONTEXT_EXTRACTION_SCHEMA_VERSION`. Auto-rebuild must not mutate a streaming session concurrently; reuse the existing rebuild gate/cooldown.

Routes return authoritative whole-graph node/edge totals from checkpoint/status, not counts from a bounded query graph.

- [ ] **Step 4: Run focused tests**

```bash
bun test apps/server/src/bridge/auto-rebuild.test.ts apps/server/src/routes-session-context.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/server/src/bridge/auto-rebuild.ts apps/server/src/bridge/auto-rebuild.test.ts apps/server/src/routes-session-context.ts apps/server/src/routes-session-context.test.ts
git commit -m "feat: rebuild stale topology extraction versions"
```

---

### Task 5: Complete-graph pair-first retrieval

**Files:**
- Create: `apps/server/src/session-pair-retrieval.ts`
- Create: `apps/server/src/session-pair-retrieval.test.ts`
- Modify: `apps/server/src/session-context.ts`
- Modify: `apps/server/src/session-context.test.ts`
- Modify: `apps/server/src/session-topology-retrieval.ts`
- Modify: `apps/server/src/session-topology-retrieval.test.ts`
- Modify: `apps/server/src/db/session-context.ts`
- [ ] **Step 1: Write failing complete-graph early-user test**

Create 1 early user/assistant pair plus 600 newer assistant child/evidence nodes. Query the early purpose and assert:

```ts
expect(result.eligibleCounts.userMain).toBe(1);
expect(result.selectedPairIds).toContain("s1:pair:u-early");
expect(result.selectedNodeIds).toContain("s1:entry:u-early:message");
expect(result.selectedNodeIds).toContain("s1:entry:a-early:message");
```

This is a two-stage RED proof: first call the legacy stored-focus path and assert the early pair is absent because `getSessionContextGraph(..., 500)` pre-cuts it; then call the wished-for `retrieveConversationPairs()` API and observe the expected module/API-missing failure.

- [ ] **Step 2: Write failing population and child-closure tests**

Tests must assert:

- with candidate budget 40 and at least 12 qualifying nodes in each population, `candidateCounts.userMain >= 12` and `candidateCounts.assistantMain >= 12`;
- child nodes do not consume main-node floors;
- user hit adds assistant partner; assistant hit adds user partner;
- test/subagent/task/error child hit adds parent assistant and paired user;
- default child expansion max 5 and same-type max 2;
- explicit child query max 8;
- incomplete/unanswered user remains a valid singleton;
- output never contains an orphan child or half pair;
- child truncation follows the exact priority: direct query match, failed/blocked/error, tests, subagent results, task state, other tool evidence;
- a rerank patch retaining only a child yields the complete parent/pair closure or drops the complete unit when it cannot fit.

- [ ] **Step 3: Run retrieval tests and verify RED**

```bash
bun test apps/server/src/session-pair-retrieval.test.ts
```

Expected: module/API missing.

- [ ] **Step 4: Implement field-aware main-node scoring**

Define internal searchable text fields and compute IDF over all eligible main nodes. Purpose/refined purpose is strongest, then operation detail, operation, title/compressed body, body. Importance is a small tie-breaker only.

Expose internal diagnostics for tests/server logs but never include them in model focus:

```ts
interface PairRetrievalResult {
  selectedPairIds: string[];
  selectedNodeIds: string[];
  selectedChildIds: string[];
  selectedEdgeIds: string[];
  artifacts: RetrievedArtifact[];
  eligibleCounts: { userMain: number; assistantMain: number; children: number };
  candidateCounts: { userMain: number; assistantMain: number; children: number };
  omitted: { pairs: number; children: number; reason: string };
}
```

- [ ] **Step 5: Implement balanced candidate floors and pair closure**

For main candidate budget K, reserve:

```ts
const floor = Math.max(8, Math.ceil(K * 0.30));
```

for each population. A qualifying candidate has nonzero lexical or embedding query score, or is admitted by pair/parent closure. Floors reserve qualifying candidates only; spill unused reservations to the other main population, then to the globally highest-scored remaining main nodes. Rank/select pair units; pair cost includes both endpoints.

- [ ] **Step 6: Implement child search and expansion**

Normal query: child search occurs after pair selection and attaches relevant children under declared bounds. Explicit child-intent detection uses the fixed token sets `test|tests|verify|verification|build|测试|验证|构建`, `task|todo|任务|待办`, `subagent|agent|scout|reviewer|子代理|代理`, and `error|failed|failure|blocked|abort|错误|失败|阻塞|中止`; a match may seed children and close upward.

- [ ] **Step 7: Integrate into stored focus path and isolate legacy retrieval**

`getStoredQueryTopologyFocus()` loads `getCompleteSessionContextGraph()`, uses v2 pair retrieval when extraction version is 2 and v2 nodes exist, and calls legacy `retrieveTopology()` only for v1 graphs. Add a boundary test in `apps/server/src/session-topology-retrieval.test.ts` proving a v2 request cannot call the bounded legacy scorer, while a v1 request still can.

Mark `session-topology-retrieval.ts` as the v1 compatibility implementation in its module documentation; remove it from all v2 orchestration imports/calls. Do not call the bounded graph API as a count probe before v2 retrieval.

- [ ] **Step 8: Run retrieval/context tests**

```bash
bun test apps/server/src/session-pair-retrieval.test.ts apps/server/src/session-topology-retrieval.test.ts apps/server/src/session-context.test.ts apps/server/src/routes-session-context.test.ts
```

Expected: all pass.

- [ ] **Step 9: Commit Task 5**

```bash
git add apps/server/src/session-pair-retrieval.ts apps/server/src/session-pair-retrieval.test.ts apps/server/src/session-context.ts apps/server/src/session-context.test.ts apps/server/src/session-topology-retrieval.ts apps/server/src/session-topology-retrieval.test.ts apps/server/src/db/session-context.ts
git commit -m "feat: retrieve complete conversational topology pairs"
```

---

### Task 6: Embedding recipe and pair-aware rerank

**Files:**
- Modify: `apps/server/src/session-context.ts`
- Modify: `apps/server/src/topology-reranker.ts`
- Modify: `apps/server/src/topology-reranker.test.ts`
- Modify: `apps/server/src/topology-rerank-siliconflow-adapter.ts`
- Modify: `apps/server/src/topology-rerank-siliconflow-adapter.test.ts`
- Modify: `apps/server/src/db/session-context.ts`

- [ ] **Step 1: Write failing labeled-embedding test**

Assert the exported `buildTopologyEmbeddingDocument(node)` returns this exact user-main string:

```text
population=user; role=main; operation=request; detail=fix_background_start; purpose=让 start 模式保持后台运行; title=Keep start mode alive; body=start mode must remain alive in the background
```

Assert a test child includes `population=assistant; role=child; childType=test; pair=<pairId>` plus its operation/purpose/title/body. Define `TOPOLOGY_EMBEDDING_RECIPE_VERSION="conversation-v2"`; persist the cache model identity as `${model}::${TOPOLOGY_EMBEDDING_RECIPE_VERSION}` so old rows cannot match and are lazily recomputed.

- [ ] **Step 2: Write failing pair-rerank contract tests**

Define sanitized candidate units:

```ts
interface TopologyRerankPairCandidate {
  pairId: string;
  user?: { id: string; operation?: string; purpose?: string | null; title: string; body: string };
  assistant?: { id: string; operation?: string; purpose?: string | null; title: string; body: string };
  children: Array<{ id: string; childType?: string; operation?: string; purpose?: string | null; body: string }>;
}
```

Assert request objects recursively exclude `importance`, `weight`, `score`, `scores`, `confidence`, `rank`, `relevance`, `cosine`, `bm25`, local/rerank reasons, candidate diagnostics, internal thresholds, and timestamps used as ranking priors. Assert an invalid ID or oversized patch falls back to local selection.

- [ ] **Step 3: Run tests and verify RED**

```bash
bun test apps/server/src/topology-reranker.test.ts apps/server/src/topology-rerank-siliconflow-adapter.test.ts apps/server/src/session-context.test.ts
```

Expected: current node-only rerank shape and embedding text fail expectations.

- [ ] **Step 4: Implement embedding recipe versioning**

Create `TOPOLOGY_EMBEDDING_RECIPE_VERSION="conversation-v2"` and exported `buildTopologyEmbeddingDocument(node)`. Pass `${config.model}::${TOPOLOGY_EMBEDDING_RECIPE_VERSION}` to `getNodeEmbeddings`/`saveNodeEmbeddings`. Change `getNodeEmbeddings(sessionId, modelIdentity)` to filter `WHERE session_id = ? AND model = ?`; `saveNodeEmbeddings` writes the same identity. Generate the exact labeled main/child documents asserted in Step 1. Existing embeddings with another model identity remain stored but are ignored and lazily replaced per node by the current single-row primary key.

- [ ] **Step 5: Implement pair candidate rerank and closure**

Rerank operates over a broader candidate-pair universe than final output. After patch:

1. kept child forces parent assistant and paired user;
2. kept user/assistant forces partner;
3. closure nodes cannot be independently demoted;
4. remove lowest-ranked unforced children first on overflow;
5. then remove lowest-ranked complete pair units;
6. never return orphan child/half pair.

- [ ] **Step 6: Update SiliconFlow documents**

Build one sanitized document per pair with bounded child summaries. Map returned indices to pair IDs. Preserve local baseline on timeout, invalid shape, or service failure.

- [ ] **Step 7: Run focused tests**

```bash
bun test apps/server/src/topology-reranker.test.ts apps/server/src/topology-rerank-siliconflow-adapter.test.ts apps/server/src/session-pair-retrieval.test.ts apps/server/src/session-context.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/server/src/session-context.ts apps/server/src/topology-reranker.ts apps/server/src/topology-reranker.test.ts apps/server/src/topology-rerank-siliconflow-adapter.ts apps/server/src/topology-rerank-siliconflow-adapter.test.ts apps/server/src/db/session-context.ts
git commit -m "feat: rerank conversational topology pairs"
```

---

### Task 7: Schema-v2 pair focus and compatibility parsers

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/session-context.ts`
- Modify: `apps/server/src/session-context.test.ts`
- Modify: `apps/server/src/routes-session-context.ts`
- Modify: `apps/server/src/routes-session-context.test.ts`
- Modify: `apps/web/src/lib/topology-focus.ts`
- Modify: `apps/web/src/lib/topology-focus.test.ts`

- [ ] **Step 1: Write failing v2 focus rendering test**

Build a selected pair with one test child and one artifact. Parse the JSON between topology tags and assert:

```ts
expect(payload.schemaVersion).toBe(2);
expect(payload.pairs[0].user.body).toContain("start mode");
expect(payload.pairs[0].assistant.body).toContain("production launcher");
expect(payload.pairs[0].children[0].childType).toBe("test");
expect(payload.pairs[0].children[0].source.messageId).toBe("tool-1");
```

Recursively reject forbidden keys:

```ts
const forbidden = new Set(["importance", "weight", "score", "scores", "rank", "confidence", "relevance", "cosine", "bm25", "reranker", "rerankReason", "localReason", "candidateDiagnostics", "threshold", "thresholds"]);
```

- [ ] **Step 2: Write failing v1/v2 web parser tests**

Assert existing v1 fixtures still parse. Add v2 pair fixture and assert user/assistant/children/artifacts/source fields parse without coercing missing optional fields.

- [ ] **Step 3: Run focus/parser tests and verify RED**

```bash
bun test apps/server/src/session-context.test.ts apps/server/src/routes-session-context.test.ts apps/web/src/lib/topology-focus.test.ts
```

Expected: renderer/parser support only v1.

- [ ] **Step 4: Implement v2 focus renderer**

Render complete pairs with non-empty query-aware bodies and source pointers. Keep outer tags and source-grounding rules. Omission counts come from complete eligible totals and distinguish pair/child output omissions internally; only safe omission counts/reason appear in focus.

Legacy graphs continue to render v1 through the compatibility path.

- [ ] **Step 5: Update route response semantics**

`nodeCount` and `edgeCount` report authoritative whole-graph/checkpoint totals. Add optional protocol/route fields `selectedNodeCount` and `selectedEdgeCount` for focus output counts; never overload the existing total fields.

- [ ] **Step 6: Implement tolerant v1/v2 parser**

Use a discriminated result:

```ts
export type TopologyFocus = TopologyFocusV1 | TopologyFocusV2;
```

Reject malformed pair structures safely without throwing UI render errors.

- [ ] **Step 7: Run focus tests and typechecks**

```bash
bun test apps/server/src/session-context.test.ts apps/server/src/routes-session-context.test.ts apps/web/src/lib/topology-focus.test.ts
bun run --filter '@omp-deck/protocol' typecheck
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit Task 7**

```bash
git add packages/protocol/src/index.ts apps/server/src/session-context.ts apps/server/src/session-context.test.ts apps/server/src/routes-session-context.ts apps/server/src/routes-session-context.test.ts apps/web/src/lib/topology-focus.ts apps/web/src/lib/topology-focus.test.ts
git commit -m "feat: render conversational topology focus v2"
```

---

### Task 8: Diagnostic topology UI hierarchy

**Files:**
- Modify: `apps/web/src/components/session/TopologyGraph.tsx`
- Create: `apps/web/src/components/session/TopologyGraph.test.ts`
- Modify: `apps/web/src/components/session/SessionContextTopologyGraph.test.ts` — legacy v1 render regression only
- Modify: `apps/web/src/views/TopologyView.tsx`
- Modify: `apps/web/src/i18n/index.ts`

- [ ] **Step 1: Write failing graph-model tests**

Export pure layout/detail helpers from `TopologyGraph.tsx` and test them in `TopologyGraph.test.ts`. Add a v2 graph fixture with user main, assistant main, test child, `answers` edge, and artifact. Assert layout assigns user/assistant lanes, positions child under assistant, and maps `answers` to a deliberate edge style.

Test the selected-node detail helper exposes population, node role, origin, operation/detail, purpose/refinement, status, pair ID, parent ID, and source turn while diagnostic importance remains UI-only. Keep one test in `SessionContextTopologyGraph.test.ts` proving the legacy v1 component still renders.

- [ ] **Step 2: Run focused web tests and verify RED**

```bash
bun test apps/web/src/components/session/TopologyGraph.test.ts apps/web/src/components/session/SessionContextTopologyGraph.test.ts
```

Expected: `TopologyGraph.tsx` does not export population-aware layout/detail helpers and the existing kind-only layout fails the v2 assertions; the legacy regression remains green.

- [ ] **Step 3: Implement population lanes and nested children**

Use population as the primary horizontal/vertical lane. Keep kind color as a secondary badge. Children inherit assistant lane position and render compactly beneath the parent; they do not compete as top-level lanes.

Add a specific `answers` edge style distinct from evidence/semantic relations.

- [ ] **Step 4: Update inspector and i18n**

Display semantic/provenance fields with English and Chinese labels. Do not expose refinement provenance as confidence; label it as model/prompt provenance.

- [ ] **Step 5: Run web tests, typecheck, and browser smoke**

```bash
bun test apps/web/src/components/session/TopologyGraph.test.ts apps/web/src/components/session/SessionContextTopologyGraph.test.ts apps/web/src/lib/topology-focus.test.ts
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/web' build
```

Start the app through the verified launcher, open `/topology`, load a rebuilt v2 historical session, and verify:

- user/assistant population lanes render;
- assistant children nest correctly;
- selecting nodes displays operation/purpose/status;
- no raw i18n keys or console errors appear;
- legacy v1 graph still renders.

- [ ] **Step 6: Commit Task 8**

```bash
git add apps/web/src/components/session/TopologyGraph.tsx apps/web/src/components/session/TopologyGraph.test.ts apps/web/src/components/session/SessionContextTopologyGraph.test.ts apps/web/src/views/TopologyView.tsx apps/web/src/i18n/index.ts
git commit -m "feat: visualize conversational topology hierarchy"
```

---

### Task 9: Frozen 1.86M-token regression and live compact proof

**Files:**
- Create: `apps/server/src/session-context-long-session.test.ts`
- No other test helper file is created; keep the deterministic fixture builder private inside this test file
- No persistent user session or raw sensitive transcript is committed

- [ ] **Step 1: Write privacy-safe dense regression fixture**

Generate a deterministic graph/session with the same failure structure as the verified snapshot:

- exactly 689 nodes;
- exactly 645 edges;
- F2–F5 early user purposes and paired assistant answers;
- more than 500 newer tool/evidence children;
- exact source token distance calibration above 1,000,000 tokens using the production tokenizer in a temporary file;
- no real user text beyond the approved benchmark phrases.

- [ ] **Step 2: Assert retrieval correctness profiles**

For local and Stella profiles, assert before model answer generation:

- F2–F5 user nodes are query-eligible;
- user node Recall@10 and pair Recall@10 are reported;
- complete pair focus contains all registered answer fields;
- matching test/subagent/task child closes upward;
- with main candidate budget 100 and output budget equivalent to 60 legacy nodes, pair recall and F2–F5 eligibility do not regress when 500 newer children exist.

External rerank integration uses the configured adapter only in a bounded live smoke, not a deterministic unit test dependency.

- [ ] **Step 3: Run full server/web tests and typechecks**

```bash
bun run typecheck
bun test apps/server/src apps/web/src
bun run --filter '@omp-deck/web' build
```

Expected: zero failures.

- [ ] **Step 4: Restart one clean RPC stack and rebuild the real historical session**

Use `./start-rpc-deck.sh stop` and `./start-rpc-deck.sh start`, verify `/api/health`, then `POST /api/sessions/:id/context/rebuild`. Confirm status reports extraction schema v2, nonzero user/assistant main nodes, children, pairs, and edges.

- [ ] **Step 5: Re-run the eight frozen real-session queries**

Measure separately:

1. local pair retrieval;
2. Stella pair retrieval;
3. Stella + configured external rerank.

Record user Recall@K, complete-pair recall, child evidence coverage, final focus cost, p50/p95 latency, and F2–F5 eligibility. Do not reuse or expose raw sensitive bodies in the report.

- [ ] **Step 6: Capture real auto-compact effect**

Follow `omp-deck-topology-effect-capture`: resume one high-density session once, subscribe over WS, send a distinctive real query, keep the subscription alive through post-compact context usage, and verify context-savings evidence contains schema-v2 pair focus with no forbidden keys.

Parse the captured schema-v2 JSON and additionally assert operation, purpose, `answers` pair relation, child type, status, artifact ownership, non-empty body, and source pointers for source-backed nodes. Forbidden-key absence alone is insufficient proof.

- [ ] **Step 7: Final review and commit**

Run a full implementation reviewer, then:

```bash
git add apps/server/src/session-context-long-session.test.ts
git commit -m "test: lock conversational topology long-session recall"
```

---

## Final Acceptance Criteria

- Historical v1 graphs remain readable until rebuilt.
- Extraction schema v2 produces one user main node and at most one final assistant main node per genuine pair.
- Tests, subagents, task state, tool evidence, and errors are assistant children with stable parent ownership.
- Every v2 node has deterministic operation/purpose semantics or an explicit unclassified/null purpose.
- Optional refinement never mutates structural fields and is provenance-labeled.
- No query path performs an importance/recency top-500 pre-cut before query scoring.
- Pair and parent-child closure are atomic through local retrieval, embedding, rerank, budget reconciliation, and focus rendering.
- F2–F5 are eligible and answer-bearing on the frozen dense long-session regression.
- Compact focus v2 carries non-empty bodies and source pointers while excluding all ranking/confidence internals.
- Full typecheck, full server/web tests, web build, browser smoke, and real auto-compact capture pass.
