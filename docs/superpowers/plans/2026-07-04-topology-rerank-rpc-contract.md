# Topology Rerank RPC Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the Phase 2C RPC/model-role contract required before wiring a real external topology reranker into `TopologyRerankModelClient`.

**Architecture:** Treat Phase 2C as a contract-definition task, not a production rerank implementation. The current deck code has an injected `TopologyRerankModelClient` seam, but no confirmed OMP RPC command that can invoke a model role headlessly. This plan records the observed command surface, defines the missing contract, and adds contract tests/docs without changing the production compact path.

**Tech Stack:** TypeScript, Bun test, omp-deck RPC bridge, OMP JSON-line RPC mode, Session Context Topology rerank seam.

---

## Grounded current state

The only command shapes currently observed in `apps/server/src/bridge/rpc.ts` and `apps/server/src/bridge/rpc-transport.ts` are:

```text
set_subagent_subscription
get_state
get_messages
prompt
compact
set_model
get_available_models
```

`OmpRpcTransport.send()` accepts open `RpcCommandBody` objects, but that is only a transport wrapper. It is not evidence that arbitrary command names are supported by OMP.

No observed deck code currently sends or handles a command equivalent to:

```text
run_model
invoke_model_role
prompt_once
headless_prompt
rerank
query_rerank
```

`apps/server/src/bridge/types.ts` also notes that RPC lacks a model-role management command. Therefore Phase 2C must first define or confirm an OMP RPC command contract for headless model-role invocation before any production `OmpRpcTopologyRerankClient` can exist.

## Scope boundaries

This plan does **not** implement real rerank calls in the compact path.

Allowed:

- Add a contract document/spec for the missing RPC command.
- Add TypeScript request/response types for the proposed command shape if they are isolated from production sends.
- Add tests that validate adapter parsing around mocked command responses.
- Add a disabled/non-wired adapter skeleton only if tests prove it does not call production RPC without an explicit command name.

Forbidden:

- Do not send unconfirmed RPC command names from production code.
- Do not add a probe/discovery command unless OMP RPC exposes an actual introspection verb.
- Do not change `getStoredQueryTopologyFocus()` to use a real network/model client yet.
- Do not allow reranker output to bypass existing strict patch validation.
- Do not expose score/reasons/reranker metadata in compact focus.

## Proposed contract

The minimum useful RPC command for Phase 2C is a one-shot model-role invocation:

```json
{
  "type": "invoke_model_role",
  "modelRole": "topology_query_reranker",
  "input": {
    "task": "query_rerank",
    "query": "current user prompt",
    "candidateNodes": [
      { "id": "node-id", "kind": "goal", "title": "...", "body": "..." }
    ],
    "candidateEdges": [
      { "id": "edge-id", "sourceNodeId": "a", "relation": "depends_on", "targetNodeId": "b" }
    ],
    "budget": { "nodeLimit": 10, "edgeLimit": 18 }
  },
  "responseFormat": {
    "type": "json_object",
    "schemaName": "TopologyRerankPatch"
  }
}
```

Expected response body:

```json
{
  "keepNodeIds": ["node-id"],
  "keepEdgeIds": ["edge-id"],
  "demoteNodeIds": ["other-node-id"],
  "reason": "brief optional rationale"
}
```

The command name is provisional. It must be accepted by the OMP RPC implementation before deck production code may call it. If OMP chooses a different command name or envelope, update this plan and the adapter tests before wiring production.

## File responsibilities

- Create: `docs/superpowers/specs/2026-07-04-topology-rerank-rpc-contract.md`
  - Human-readable contract spec for OMP RPC maintainers and deck implementers.
- Create: `apps/server/src/topology-rerank-rpc-contract.ts`
  - Isolated TypeScript types and parsers for the proposed request/response envelope.
  - No production RPC send call.
- Create: `apps/server/src/topology-rerank-rpc-contract.test.ts`
  - Contract parser tests for accepted and rejected response envelopes.
- Modify later only after OMP RPC support exists: `apps/server/src/bridge/rpc.ts`
  - Add `OmpRpcTopologyRerankClient` that implements `TopologyRerankModelClient` by sending the confirmed command.

---

### Task 1: Write the human-readable RPC contract spec

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-topology-rerank-rpc-contract.md`

- [ ] **Step 1: Create the spec file**

Write:

```markdown
# Topology Rerank RPC Contract

## Purpose

`omp-deck` has an injected `TopologyRerankModelClient` seam for Session Context Topology Phase 2, but no confirmed OMP RPC command currently invokes a model role headlessly. This contract defines the minimum command shape needed before deck can wire a production RPC-backed reranker.

## Observed RPC command surface

Grounded command names currently used by deck:

- `set_subagent_subscription`
- `get_state`
- `get_messages`
- `prompt`
- `compact`
- `set_model`
- `get_available_models`

No observed command currently provides one-shot model-role invocation or JSON-schema-constrained rerank output.

## Required command semantics

The command must:

1. Invoke a configured model role without mutating the active chat transcript.
2. Accept a sanitized `TopologyRerankRequest` object.
3. Return either a direct strict `RerankPatch` JSON object or an RPC envelope whose `output` field is a strict `RerankPatch` JSON object.
4. Enforce a timeout at the deck caller or OMP RPC layer.
5. Preserve prompt safety: failed calls must be distinguishable from valid empty patches so deck can fall back to local retrieval.

## Proposed request envelope

```json
{
  "type": "invoke_model_role",
  "modelRole": "topology_query_reranker",
  "input": {
    "task": "query_rerank",
    "query": "current user prompt",
    "candidateNodes": [
      { "id": "node-id", "kind": "goal", "title": "...", "body": "..." }
    ],
    "candidateEdges": [
      { "id": "edge-id", "sourceNodeId": "a", "relation": "depends_on", "targetNodeId": "b" }
    ],
    "budget": { "nodeLimit": 10, "edgeLimit": 18 }
  },
  "responseFormat": {
    "type": "json_object",
    "schemaName": "TopologyRerankPatch"
  }
}
```

## Expected response

Preferred response body: a direct `RerankPatch` JSON object.

```json
{
  "keepNodeIds": ["node-id"],
  "keepEdgeIds": ["edge-id"],
  "demoteNodeIds": ["other-node-id"],
  "reason": "brief optional rationale"
}
```

Deck also accepts the same patch wrapped under `output` to tolerate RPC envelopes that separate transport metadata from model output:

```json
{
  "output": {
    "keepNodeIds": ["node-id"],
    "keepEdgeIds": ["edge-id"],
    "demoteNodeIds": ["other-node-id"],
    "reason": "brief optional rationale"
  }
}
```

Any other response shape is treated as invalid and falls back to local retrieval.

## Deck-side safety invariants
Deck must parse every RPC response with `parseTopologyRerankRpcResponse()` first. That adapter accepts the documented direct or `output`-wrapped response envelope, delegates the extracted candidate patch to shape-only `parseRerankPatch()`, and rejects malformed fields.

Before any patch affects final focus, the production caller must still run graph-local `validateRerankPatch()` to enforce selected-node/selected-edge membership, candidate-only promotion rejection, demotion behavior, and output budget constraints.

A real RPC client must not:

- promote candidate-only nodes into final focus;
- include scores, reasons, confidence, or reranker metadata in compact focus;
- abort the user prompt when rerank fails;
- mutate model roles or active session state.

## Open confirmation item

The command name `invoke_model_role` is provisional. OMP RPC must either implement this exact command or document the supported equivalent before deck wires production calls.
```

- [ ] **Step 2: Self-review the spec**

Check the spec includes:

- the observed command list;
- explicit absence of a confirmed headless command;
- request envelope;
- response object;
- safety invariants;
- provisional command-name warning.

Expected: all six items are present.

---

### Task 2: Add isolated contract parser tests

**Files:**
- Create: `apps/server/src/topology-rerank-rpc-contract.test.ts`
- Create later in Task 3: `apps/server/src/topology-rerank-rpc-contract.ts`

- [ ] **Step 1: Write failing parser tests**

Create `apps/server/src/topology-rerank-rpc-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { buildTopologyRerankRpcCommand, parseTopologyRerankRpcResponse } from "./topology-rerank-rpc-contract.ts";
import type { TopologyRerankRequest } from "./topology-reranker.ts";

const request: TopologyRerankRequest = {
	task: "query_rerank",
	query: "topology",
	candidateNodes: [{ id: "a", kind: "goal", title: "A", body: "body A" }],
	candidateEdges: [],
	budget: { nodeLimit: 10, edgeLimit: 18 },
};

describe("buildTopologyRerankRpcCommand", () => {
	test("builds the provisional model-role invocation envelope", () => {
		expect(buildTopologyRerankRpcCommand({ modelRole: "topology_query_reranker", request })).toEqual({
			type: "invoke_model_role",
			modelRole: "topology_query_reranker",
			input: request,
			responseFormat: { type: "json_object", schemaName: "TopologyRerankPatch" },
		});
	});
});

describe("parseTopologyRerankRpcResponse", () => {
	test("returns patch object from direct JSON response", () => {
		expect(parseTopologyRerankRpcResponse({ keepNodeIds: ["a"], keepEdgeIds: [], demoteNodeIds: [] })).toEqual({
			keepNodeIds: ["a"],
			keepEdgeIds: [],
			demoteNodeIds: [],
		});
	});

	test("returns patch object from response.output", () => {
		expect(parseTopologyRerankRpcResponse({ output: { keepNodeIds: ["a"], keepEdgeIds: [], demoteNodeIds: [] } })).toEqual({
			keepNodeIds: ["a"],
			keepEdgeIds: [],
			demoteNodeIds: [],
		});
	});

	test("preserves optional reason from direct and wrapped responses", () => {
		expect(parseTopologyRerankRpcResponse({ keepNodeIds: ["a"], keepEdgeIds: [], demoteNodeIds: [], reason: "matched query" })).toEqual({
			keepNodeIds: ["a"],
			keepEdgeIds: [],
			demoteNodeIds: [],
			reason: "matched query",
		});
		expect(parseTopologyRerankRpcResponse({ output: { keepNodeIds: ["a"], keepEdgeIds: [], demoteNodeIds: [], reason: "wrapped" } })).toEqual({
			keepNodeIds: ["a"],
			keepEdgeIds: [],
			demoteNodeIds: [],
			reason: "wrapped",
		});
	});

	test("rejects non-object and invalid patch responses", () => {
		expect(parseTopologyRerankRpcResponse("not json")).toBeUndefined();
		expect(parseTopologyRerankRpcResponse({ output: { keepNodeIds: [1], keepEdgeIds: [], demoteNodeIds: [] } })).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the red test**

Run:

```bash
bun test apps/server/src/topology-rerank-rpc-contract.test.ts
```

Expected: FAIL because `topology-rerank-rpc-contract.ts` does not exist.

---

### Task 3: Add isolated contract helpers

**Files:**
- Create: `apps/server/src/topology-rerank-rpc-contract.ts`
- Test: `apps/server/src/topology-rerank-rpc-contract.test.ts`

- [ ] **Step 1: Implement the contract helpers without production sends**

Create `apps/server/src/topology-rerank-rpc-contract.ts`:

```ts
import type { RerankPatch, TopologyRerankRequest } from "./topology-reranker.ts";
import { parseRerankPatch } from "./topology-reranker.ts";

export interface TopologyRerankRpcCommand {
	type: "invoke_model_role";
	modelRole: string;
	input: TopologyRerankRequest;
	responseFormat: { type: "json_object"; schemaName: "TopologyRerankPatch" };
}

export function buildTopologyRerankRpcCommand(input: {
	modelRole: string;
	request: TopologyRerankRequest;
}): TopologyRerankRpcCommand {
	return {
		type: "invoke_model_role",
		modelRole: input.modelRole,
		input: input.request,
		responseFormat: { type: "json_object", schemaName: "TopologyRerankPatch" },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTopologyRerankRpcResponse(raw: unknown): RerankPatch | undefined {
	const direct = parseRerankPatch(raw);
	if (direct) return direct;
	if (!isRecord(raw)) return undefined;
	return parseRerankPatch(raw.output);
}
```

- [ ] **Step 2: Run contract tests**

Run:

```bash
bun test apps/server/src/topology-rerank-rpc-contract.test.ts
```

Expected: PASS.

---

### Task 4: Final verification for contract-definition work

**Files:**
- No additional source edits unless verification fails.

- [ ] **Step 1: Run contract and reranker tests**

Run:

```bash
bun test apps/server/src/topology-rerank-rpc-contract.test.ts apps/server/src/topology-reranker.test.ts
```

Expected: all tests pass with `0 fail`.

- [ ] **Step 2: Run server typecheck**

Run:

```bash
bun run --filter '@omp-deck/server' typecheck
```

Expected: exit 0.

- [ ] **Step 3: Check changed files**

Run:

```bash
git status --short
```

Expected new files for this Phase 2C contract step:

```text
?? docs/superpowers/specs/2026-07-04-topology-rerank-rpc-contract.md
?? apps/server/src/topology-rerank-rpc-contract.test.ts
?? apps/server/src/topology-rerank-rpc-contract.ts
```

Other already-existing Phase 2 seam files may still appear from the prior task. Do not revert them as part of this contract step.

## Self-review notes

- Spec coverage: defines current observed RPC command surface, explicitly records absence of a confirmed headless model-role/rerank command, and proposes the minimum contract needed for a future `OmpRpcTopologyRerankClient`.
- Placeholder scan: no TBD/TODO/fill-in placeholders; the provisional command name is explicitly marked as requiring OMP RPC confirmation.
- Type consistency: `TopologyRerankRequest`, `RerankPatch`, `TopologyRerankModelClient`, and `topology_query_reranker` names match the existing Phase 2 seam.
