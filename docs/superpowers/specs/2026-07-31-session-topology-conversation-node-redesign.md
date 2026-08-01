# Session Context Topology Conversation Node Redesign

**Date:** 2026-07-31  
**Status:** Approved design  
**Scope:** Session Context Topology extraction, persistence, retrieval, rerank, compact focus, and diagnostic UI contracts.

## 1. Problem

The current Session Context Topology mixes user goals, assistant decisions, tool output, tests, logs, task state, and other evidence in one node population. Before query-aware retrieval, `getSessionContextGraph()` globally orders nodes by `importance DESC, created_at DESC` and limits the graph to 500 nodes. In the verified 1.86M-token session snapshot, early user goals were extracted correctly but removed by this pre-cut. Local ranking, Stella embeddings, external rerank, and larger final output budgets could not recover facts that were absent from the candidate graph.

The redesign must preserve conversational intent and answer provenance without letting tool-heavy evidence crowd out user requests.

## 2. Goals

1. Separate conversational nodes into two main populations: user and assistant.
2. Give every new extracted node explicit operation and purpose semantics.
3. Represent one conversational turn as one user main node paired with one assistant final-answer main node.
4. Represent tests, subagent results, task state, tool evidence, and errors as assistant child nodes.
5. Retrieve main nodes first, close complete question-answer pairs, then expand relevant children.
6. Eliminate the global 500-node importance/recency pre-cut as a source of query recall loss.
7. Preserve deterministic extraction and historical reproducibility; optional model refinement must be non-authoritative and provenance-labeled.
8. Keep model-facing focus free of internal ranking and confidence fields.

## 3. Non-goals

- Do not treat every tool call or tool result as a globally visible conversational node.
- Do not infer purpose from keyword adjacency, tool output prose, or nearby issues.
- Do not materialize a dedicated conversation-pair table in the first implementation.
- Do not write Session Context Topology data into Mnemopi.
- Do not remove the existing `kind` axis immediately; retain it during migration for legacy API/UI compatibility.
- Do not expose importance, weight, scores, confidence, or rerank diagnostics in compact focus.

## 4. Conceptual Model

### 4.1 Main populations

The only main conversational populations are:

```ts
type SessionContextPopulation = "user" | "assistant";
```

- `user`: a genuine, non-synthetic user-authored prompt, request, correction, question, constraint, approval, or report.
- `assistant`: the final assistant answer for a conversational pair.

System, developer, custom notices, tools, subagents, and task trackers are not user/assistant main populations merely because their text appears in the transcript.

### 4.2 Node role and origin

```ts
type SessionContextNodeRole = "main" | "child";

type SessionContextNodeOrigin =
  | "user"
  | "assistant"
  | "tool"
  | "subagent"
  | "task";
```

- Main user node: `population=user`, `nodeRole=main`, `origin=user`.
- Main assistant node: `population=assistant`, `nodeRole=main`, `origin=assistant`.
- Child nodes belong to the assistant population structurally but retain their actual origin, such as `tool`, `subagent`, or `task`.

### 4.3 Child types

```ts
type SessionContextChildType =
  | "test"
  | "subagent_result"
  | "task_state"
  | "tool_evidence"
  | "error";
```

Child nodes use `parentNodeId` to attach to the assistant main node in the same pair.

### 4.4 Operation and purpose

Every extraction-schema-v2 node has:

```ts
type SessionContextOperation =
  | "ask"
  | "request"
  | "provide"
  | "correct"
  | "constrain"
  | "approve"
  | "reject"
  | "report"
  | "answer"
  | "plan"
  | "investigate"
  | "implement"
  | "modify"
  | "verify"
  | "explain"
  | "summarize"
  | "delegate"
  | "track"
  | "observe"
  | "unknown";

type SessionContextPurposeSource =
  | "explicit_text"
  | "structured_intent"
  | "deterministic"
  | "unclassified";

interface SessionContextPurpose {
  operation: SessionContextOperation;
  operationDetail?: string;
  purpose: string | null;
  purposeSource: SessionContextPurposeSource;
  refinedPurpose?: string;
  refinement?: {
    model: string;
    promptVersion: string;
  };
}
```

`operation` is a stable category. `operationDetail` is an optional snake_case specialization. `purpose` is the deterministic baseline. `refinedPurpose` is optional model output and never overwrites the baseline.

Deterministic operation applicability:

| Population / node role | Allowed operations |
|---|---|
| User main | `ask`, `request`, `provide`, `correct`, `constrain`, `approve`, `reject`, `report`, `unknown` |
| Assistant main | `answer`, `plan`, `investigate`, `implement`, `modify`, `provide`, `explain`, `summarize`, `report`, `unknown` |
| Test / tool / error child | `verify`, `observe`, `modify`, `report`, `unknown` |
| Subagent-result child | `delegate`, `investigate`, `implement`, `explain`, `summarize`, `unknown` |
| Task-state child | `track`, `unknown` |

`provide` means supplying context or a requested result without claiming a modification: a user may provide logs/files/context, while an assistant may provide requested information. `modify` is reserved for an assistant or tool-origin child that changed state; a user correction uses `correct`. `delegate` describes the assistant-owned subagent-result child, not the user request that triggered it.

### 4.5 Status

```ts
type SessionContextNodeStatus =
  | "pending"
  | "completed"
  | "failed"
  | "blocked"
  | "aborted"
  | "unknown";
```

Status comes from structured transcript data when available: assistant stop reason, tool `isError`, process exit code, task state, or subagent completion state.

## 5. Conversation Pair Model

Each genuine user prompt opens one pair with a stable `pairId`.

```text
User main node U
      ▲
      │ answers
Assistant main node A
      ├── child: test
      ├── child: subagent_result
      ├── child: task_state
      ├── child: tool_evidence
      ├── child: error
      └── artifacts
```

The `answers` edge direction is:

```text
assistant --answers--> user
```

### 5.1 Pair boundary rules

1. Resolve the active transcript branch using entry IDs and `parentId`; do not treat physical JSONL line order as the authoritative conversation path.
2. A genuine user message opens a pair only when `role=user`, `synthetic !== true`, and it is not agent-attributed machine continuation.
3. Developer, system, custom/advisor, lifecycle, and tool messages attach to the open pair but do not open or close it.
4. Assistant messages with `stopReason=toolUse` are intermediate execution events, not final answer nodes.
5. The final answer is the last non-empty assistant text after tool calls resolve, with `stopReason=stop|length` when available.
6. `error` or `aborted` closes the pair incomplete. A tool-only span does not create a fabricated final assistant answer.
7. When historical records omit stop reason, the last non-empty assistant message before the next genuine user prompt is a candidate final answer with `status=unknown`; provenance records that fallback.
8. The next genuine user prompt closes any unresolved prior pair as unanswered unless structured interruption/abort data establishes another status.

## 6. Child Node Extraction

### 6.1 Tests

A test child node is created from a structured test command/result, not merely from prose containing `pass`, `fail`, or `error`.

Example:

```json
{
  "childType": "test",
  "operation": "verify",
  "operationDetail": "run_server_test_suite",
  "purpose": "验证模型角色修改没有引入回归",
  "status": "completed"
}
```

Store bounded summaries and structured facts: command, pass/fail counts, exit code, duration, and source result reference.

### 6.2 Subagent results

Persist one child node for the subagent's final result, not each intermediate status message.

```json
{
  "childType": "subagent_result",
  "operation": "delegate",
  "operationDetail": "audit_model_role_routes",
  "purpose": "调查 Windows 模型角色不同步原因",
  "status": "completed"
}
```

Preserve safe agent identity, delegated target, final conclusion summary, mutation status, and artifact reference. Lifecycle polling remains hidden provenance.

### 6.3 Task state

Maintain one current child node per stable task identity. State transitions update the derived graph on rebuild rather than creating globally retrieved status-history nodes.

```json
{
  "childType": "task_state",
  "operation": "track",
  "operationDetail": "verify_arena_recommender",
  "purpose": "完成榜单推荐器验证",
  "status": "completed"
}
```

### 6.4 Tool evidence

Tool calls and results are parsed structurally and paired by exact `toolCallId`. They are not global main nodes. Promote a bounded child evidence node only for semantically useful outcomes:

- meaningful read/search observation;
- file mutation confirmation;
- API verification;
- generated asset;
- structured test/build result;
- structured error.

Skipped, queued, superseded, empty, cancelled-before-execution, pure polling, or repetitive log outputs remain hidden provenance.

A successful tool result is an observation, not automatically proof that an issue is fixed. Do not emit `verified_by` or `fixed_by` from proximity.

### 6.5 Artifacts

Keep `SessionContextArtifact` distinct from child nodes. Attach files, commits, URLs, commands, APIs, logs, images, and generated assets to an assistant main node or child node. Prefer structured tool arguments/details; regex extraction is a marked legacy fallback.

## 7. Deterministic Extraction and Optional Refinement

### 7.1 Deterministic baseline

The baseline extractor is envelope-first and preserves complete structured messages before flattening text. It derives:

- population and origin from role, synthetic flag, attribution, and entry type;
- pair boundaries from active branch and message lifecycle;
- tool pairing from exact IDs;
- operation from controlled record/tool mappings;
- purpose from explicit user/assistant text, `ToolCall.intent`, subagent task, task text, and structured command/result context;
- status from structured fields.

When purpose is not explicit:

```text
purpose = null
purposeSource = unclassified
```

No keyword/proximity guess is allowed.

### 7.2 Optional model refinement

A fast model may normalize or refine `operationDetail` and `refinedPurpose`. It cannot change:

- population or origin;
- node role or child type;
- pair ID or parent node ID;
- source IDs or timestamps;
- tool call/result pairing;
- deterministic purpose;
- structured status.

Refinement failure falls back to deterministic data. Each refinement records model and prompt version.

## 8. Persistence and Migration

### 8.1 Protocol fields

Add optional fields to `SessionContextNode` for backward compatibility:

```ts
population?: SessionContextPopulation;
nodeRole?: SessionContextNodeRole;
origin?: SessionContextNodeOrigin;
childType?: SessionContextChildType;
pairId?: string;
parentNodeId?: string;
operation?: SessionContextOperation;
operationDetail?: string;
purpose?: string | null;
purposeSource?: SessionContextPurposeSource;
refinedPurpose?: string;
refinement?: {
  model: string;
  promptVersion: string;
};
status?: SessionContextNodeStatus;
```

Fields are optional in the public protocol so legacy graphs remain valid; extraction schema v2 requires them for new nodes according to node type.

Add `answers` to `SessionContextEdgeRelation`.

### 8.2 Database columns

Add nullable columns to `session_context_nodes`:

```text
population
node_role
origin
child_type
pair_id
parent_node_id
operation
operation_detail
purpose
purpose_source
refined_purpose
refinement_json
status
```

The conceptual `SessionContextPurpose` object maps to these flat protocol/DB fields. `refinement` is persisted in `refinement_json` as a validated object containing only `model` and `promptVersion`; absent or invalid JSON maps to `undefined`. It is provenance, never ranking input.

Add indexes only where the new retrieval path uses them, including population/main-child and pair/parent lookup indexes.

Add `extraction_schema_version INTEGER NOT NULL DEFAULT 1` to checkpoints. Current version becomes 2. A graph is stale when the source changes or the extraction version is older than the server version.

### 8.3 Edge migration

The edge relation column has a SQL `CHECK`. Add `answers` via a transactionally data-preserving edge-table rebuild and recreate its indexes and foreign keys. Do not overload `depends_on` with answer semantics.

### 8.4 Legacy relation policy

Legacy relation strings remain readable for backward compatibility, but extraction schema v2 does not recreate proximity-derived semantic claims. The deterministic v2 extractor emits `answers` from exact pair boundaries. Parent-child ownership uses `parentNodeId`, and artifacts use their existing `node_id` attachment.

`caused_by`, `fixed_by`, `verified_by`, `depends_on`, `supersedes`, `contradicts`, `blocks`, `summarizes`, `references_file`, and `continues` may survive on legacy graphs until rebuild. A v2 rebuild emits them only when an explicit structured protocol field establishes the relation. An optional model semantic layer may add them with provenance identifying model and prompt version, but it cannot replace or contradict structural `answers`, pair IDs, parent IDs, or exact tool-call/result links. Successful tool output alone never creates `verified_by` or `fixed_by`.

### 8.5 Stable identity

New node IDs derive from stable source entry ID plus a block discriminator, not inferred kind, operation, or model-refined fields. Pair IDs derive from the genuine user prompt entry. Child IDs derive from pair ID and stable call/task/agent identifiers.

Historical migration is a full deterministic rebuild from JSONL. Rebuild replaces nodes, edges, artifacts, embeddings, and checkpoint version.

## 9. Retrieval Architecture

### 9.1 Remove the global pre-cut

Query-aware retrieval must operate over the complete eligible conversational graph or balanced DB candidate pools. It must not begin with:

```sql
ORDER BY importance DESC, created_at DESC LIMIT 500
```

The first correctness implementation should load the complete graph in memory. This provides a reference oracle and is operationally acceptable for the currently observed graph sizes. A later DB/FTS candidate implementation may optimize the same semantic contract.

### 9.2 Main-node retrieval lanes

Ordinary queries retrieve only user and assistant main nodes initially. Maintain independent minimum candidate floors for both populations; tool/subagent/task children cannot consume these floors.

Search fields, in descending semantic importance:

1. `refinedPurpose` when present, otherwise `purpose`;
2. `operationDetail`;
3. `operation`;
4. title and compressed body;
5. full body as recall fallback;
6. importance only as a small tie-breaker.

Embedding documents use labeled fields so operation and purpose remain distinct.

### 9.3 Pair closure

If a user main node is selected, add its paired assistant answer when available. If an assistant main node is selected, add the paired user request. Budget and truncate by pair cost, not isolated node count.

Unanswered user nodes remain valid singleton candidates. Unpaired legacy nodes use deterministic compatibility logic and are never paired solely by semantic similarity.

### 9.4 Child expansion

After selecting pairs, attach at most **5 children per assistant** by default. No more than 2 children of the same `childType` are included unless the query explicitly targets that type. An explicit test/task/subagent/error query may raise the per-assistant limit to 8, still subject to the global focus budget. Truncation follows this priority:

1. direct query match;
2. failed/blocked/error;
3. tests;
4. subagent final results;
5. current task state;
6. other tool evidence.

Explicit queries about tests, tasks, subagents, or errors may seed a child search lane. A matched child then closes upward to its assistant parent and paired user node. Child nodes do not consume the reserved user/assistant main-node candidate floors.

### 9.5 External rerank

External rerank receives sanitized candidate pair units, broader than final output. It may reorder or promote only pair/child IDs from that candidate universe. After applying its patch, re-enforce pair atomicity and parent/child integrity.

Post-rerank closure is deterministic:

1. Every kept child force-keeps its assistant parent and that assistant's paired user node.
2. Every kept user or assistant main node force-keeps its available pair partner.
3. Forced closure nodes cannot be independently demoted.
4. If closure exceeds the budget, remove the lowest-ranked unforced children first, then remove the lowest-ranked complete pair units; never emit an orphan child or half pair.
5. A patch that keeps only a child therefore yields the complete owning pair plus that child, or drops that entire closure unit when it cannot fit.

Never send internal importance, weights, retrieval scores, confidence, rank reasons, timestamps used as ranking priors, or thresholds.

## 10. Model-facing Focus Contract

Keep `<session_topology_subgraph>` tags and bump JSON payload schema to version 2. Render pair-oriented content:

```json
{
  "schemaVersion": 2,
  "pairs": [
    {
      "pairId": "p42",
      "user": {
        "id": "u42",
        "operation": "request",
        "operationDetail": "fix_background_start",
        "purpose": "让 start 模式保持后台运行",
        "purposeSource": "explicit_text",
        "body": "日常启动脚本在 start 模式下无法保持服务后台工作。",
        "status": "completed",
        "source": { "messageId": "m-user-42", "turnIndex": 218 }
      },
      "assistant": {
        "id": "a42",
        "operation": "implement",
        "operationDetail": "use_production_launcher",
        "purpose": "修复后台服务退出",
        "purposeSource": "deterministic",
        "body": "将后台启动切换为生产 launcher，并补齐前端构建步骤。",
        "status": "completed",
        "source": { "messageId": "m-assistant-42", "turnIndex": 223 }
      },
      "children": [
        {
          "id": "test-42",
          "childType": "test",
          "operation": "verify",
          "operationDetail": "run_background_smoke",
          "purpose": "确认后台模式可以持续运行",
          "purposeSource": "structured_intent",
          "body": "后台启动后 health endpoint 返回 200，进程保持监听。",
          "status": "completed",
          "source": { "messageId": "m-tool-42", "turnIndex": 224 }
        }
      ],
      "artifacts": [
        { "kind": "file", "ref": "start-rpc-deck.sh" }
      ]
    }
  ]
}
```

Every rendered user, assistant, and child node carries a non-empty query-relevant `body` in addition to structured operation/purpose fields. `source.messageId` and `source.turnIndex` are included when available; legacy data may omit either source component, but v2 extraction must preserve both for source-backed messages.

The diagnostic graph API may expose stored importance and edge weight to the UI. The model-facing focus must recursively exclude:

- importance and weight;
- score, rank, relevance, cosine, BM25;
- confidence;
- local or rerank reasons;
- internal thresholds and candidate diagnostics.

## 11. Legacy Pack and UI Compatibility

- Retain `kind` during migration so the current pack response and node color mapping remain functional.
- Update the focus parser to accept both schema v1 and v2.
- Diagnostic topology UI should group or lay out main nodes by population and display children nested under assistant nodes; kind remains a secondary semantic badge.
- Legacy rows without v2 fields remain readable and can use conservative compatibility classification until rebuilt.

## 12. Validation Requirements

### 12.1 Extraction and pair boundaries

- Simple user → final assistant creates one pair and one `answers` edge.
- User → assistant toolUse → multiple out-of-order tool results → final assistant still creates exactly two main nodes.
- Synthetic user, developer, system, advisor, and custom notices do not create user main nodes.
- Tool-only, aborted, and error turns do not create false final-answer nodes.
- Missing stop reason records compatibility fallback provenance.
- Active branch extraction ignores abandoned branch content.

### 12.2 Child nodes

- Structured test result creates a test child with command, status, and bounded summary.
- File content containing the word `error` does not create an error child when structured status is success.
- `isError=true` or nonzero exit code creates an error child even without failure words.
- One final subagent result creates one child; polling and lifecycle chatter do not.
- Task state is represented by current stable task identity rather than every transition.
- Exact tool call IDs pair duplicate tool names correctly; no proximity fallback.

### 12.3 Retrieval and scale

- More than 500 newer evidence/tool events cannot make an exact early user-purpose query ineligible.
- User and assistant candidate floors are independently maintained.
- Child nodes do not consume conversational main-node quota.
- Matching user purpose closes to assistant answer; matching assistant action closes to user request.
- Matching a test, subagent, task, or error child closes upward to the complete pair.
- Pair endpoint and parent-child integrity survive output truncation and rerank.

- Child expansion never exceeds the declared per-assistant/type bounds and follows the priority order.
- A rerank patch that keeps only a child either returns the complete parent/pair closure or drops that complete unit when it cannot fit.

### 12.4 Frozen long-session regression

Use the uncontaminated 1.86M-token benchmark snapshot. The following previously lost facts must be query-eligible before scoring:

- F2: delete unused scripts;
- F3: Windows active-model/custom-provider/role synchronization problems;
- F4: start mode background process exit;
- F5: thinking-level control, workspace folder creation, and full OMP settings editing.

Report local lexical, Stella embedding, and embedding + external rerank separately, including user-node recall, pair recall, answer-bearing focus coverage, p50/p95 latency, candidate counts, and output cost.

### 12.5 Focus leakage and content integrity

Parse the JSON inside the topology tags and recursively reject forbidden ranking keys. Assert correct operation, purpose, pair relation, child type, status, artifact ownership, non-empty body content, and source pointers for v2 source-backed nodes.

## 13. Delivery Sequence

1. Add protocol types and additive node/checkpoint migrations, including `refinement_json` and extraction-version staleness.
2. Add the data-preserving `answers` edge migration using a transactional edge-table rebuild that expands the relation `CHECK`, preserves foreign keys, and recreates all indexes.
3. Implement envelope-first, branch-aware normalization and deterministic pair extraction.
4. Add assistant child extraction for tests, subagents, tasks, tools, and errors.
5. Version auto-rebuild checkpoints and rebuild historical graphs.
6. Implement complete-graph, population-balanced, pair-first retrieval with bounded child expansion.
7. Add optional refinement and version the embedding input recipe.
8. Update rerank to pair candidates and enforce the specified closure reconciliation after patches.
9. Add schema-v2 pair focus with non-empty bodies/source pointers while retaining v1 parser compatibility.
10. Update diagnostic UI for population lanes and nested children.
11. Run the frozen 1.86M-token regression and live auto-compact capture.

## 14. Final Decision

Adopt **two conversational main populations, pair-first retrieval, and assistant-owned child nodes**.

The resulting hierarchy is:

```text
User purpose
  └─ answered by Assistant operation/purpose
       ├─ test verification
       ├─ subagent final result
       ├─ current task state
       ├─ tool evidence / error
       └─ artifacts
```

This solves the confirmed candidate-precut failure at its source instead of compensating by sending ever more mixed nodes.