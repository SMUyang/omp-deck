# Query-Time Topology External Rerank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the async plumbing, strict patch layer, and injected-client seam needed for optional external reranking of the existing query-time Session Context Topology compact focus while preserving local retrieval as the safe fallback.

**Architecture:** Keep the existing local `retrieveTopology()` path as the baseline. Extend its returned metadata with ranked candidate ids and scores, add a strict rerank patch layer, then make `getStoredQueryTopologyFocus()` async so it can optionally call an injected reranker before rendering the same clean topology JSON. Both compact bridges must `await` the async getter. This plan does not implement a real OMP RPC/model-role headless invocation; that is a separate Phase 2C after the RPC/model-role call shape is confirmed or defined.
**Tech Stack:** TypeScript, Bun test, existing OMP Deck server modules, existing `@omp-deck/protocol` session context types.

---

## Current-state anchors

- `apps/server/src/session-topology-retrieval.ts` already exists. It currently returns `selectedNodeIds`, `selectedEdgeIds`, `artifacts`, and `omitted`.
- Current baseline selection has a subtle ordering behavior: after ranking candidates and expanding neighbors, it does `graph.nodes.filter((node) => expanded.has(node.id)).slice(...)`, so `selectedNodeIds` preserve graph/storage order, not local ranking order.
- This plan preserves that local baseline order. It adds ranked metadata for trigger decisions only. The reranker request sees only the local selected subgraph, and accepted patches are confined to `local.selectedNodeIds` / `local.selectedEdgeIds`; it does not promote candidate-only nodes into the final compact focus.
- `apps/server/src/session-context.ts` currently exposes synchronous `getStoredQueryTopologyFocus()` at lines 454-470.
- `apps/server/src/bridge/in-process.ts` currently calls the getter synchronously in `maybeAutoCompactContext()` at line 934.
- `apps/server/src/bridge/rpc.ts` currently calls the getter synchronously in `maybeAutoCompactContext()` at line 563.
- External rerank is async I/O. Therefore `getStoredQueryTopologyFocus()` must become `async`, and both bridge compact callsites must `await` it.
- Compact focus sent to the model must stay clean: no `importance`, `weight`, `confidence`, `relevance`, `score`, `reasons`, or reranker metadata.


## External client contract boundary

The inspected RPC transport currently shows generic `prompt`, `set_model`, and `compact` command paths, not a confirmed “invoke model role headless rerank” contract. Therefore Tasks 1-6 are implementable with a fake/injected `TopologyRerankModelClient` only. A real external client is deliberately deferred to Phase 2C and has a hard precondition: confirm or define the OMP RPC/model-role call shape for `topology_query_reranker` before wiring production network/model I/O.
## File responsibilities

- Modify `apps/server/src/session-topology-retrieval.ts`: extend existing retrieval result metadata without changing the current local baseline selection order.
- Modify `apps/server/src/session-topology-retrieval.test.ts`: prove ranking metadata exists and prove baseline selected ids still follow graph order after expansion.
- Create `apps/server/src/config-topology-rerank.ts`: parse environment-backed external rerank config.
- Create `apps/server/src/config-topology-rerank.test.ts`: cover config defaults and invalid env fallback.
- Create `apps/server/src/topology-reranker.ts`: pure trigger/request/patch parsing/validation/application helpers plus an async injected-client wrapper.
- Create `apps/server/src/topology-reranker.test.ts`: cover trigger logic, selected-subgraph request sanitization, strict patch validation, patch application, and async fallback behavior.
- Modify `apps/server/src/session-context.ts`: make `getStoredQueryTopologyFocus()` async, call the injected reranker when triggered, and render fallback local focus on failures.
- Modify `apps/server/src/session-context.test.ts`: add DB-backed tests that import/await the getter and cover injected rerank success/fallback/clean-focus invariants.
- Modify `apps/server/src/bridge/in-process.ts`: await async focus getter before `session.compact(focus)`.
- Modify `apps/server/src/bridge/rpc.ts`: await async focus getter before sending RPC `compact` command.

## Constants and naming

Use these names consistently:

```ts
export const DEFAULT_TOPOLOGY_RERANK_CONFIG: TopologyRerankConfig = {
	enabled: true,
	rerankModelRole: "topology_query_reranker",
	minContextPercent: 12,
	minCandidateNodes: 16,
	localConfidenceBelow: 0.72,
	timeoutMs: 30_000,
};
```

Use these env var names:

```text
OMP_DECK_TOPOLOGY_RERANK_ENABLED
OMP_DECK_TOPOLOGY_RERANK_ROLE
OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT
OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES
OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW
OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS
```

Do not implement `fallbackOnError`; fallback is always local retrieval for prompt safety.

---

### Task 1: Extend retrieval metadata without changing local baseline order

**Files:**
- Modify: `apps/server/src/session-topology-retrieval.ts`
- Test: `apps/server/src/session-topology-retrieval.test.ts`

- [ ] **Step 1: Write failing tests for ranking metadata and current baseline order**

Add these imports and tests to `apps/server/src/session-topology-retrieval.test.ts` inside `describe("retrieveTopology", ...)`:

```ts
	test("returns ranked candidate metadata without changing graph-order baseline selection", () => {
		const unrelatedFirst = node("n_unrelated", "issue", "Subscription error", "GLM-5V-Turbo not in plan", 0.1);
		const queryMatchSecond = node("n_match", "goal", "batch legend label", "render non-abbreviated legend labels", 0.9);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, candidateNodeLimit: 2, outputNodeLimit: 2 },
			graph({ nodes: [unrelatedFirst, queryMatchSecond], totalNodes: 2 }),
		);

		expect(result?.selectedNodeIds).toEqual(["n_unrelated", "n_match"]);
		expect(result?.rankedCandidateNodeIds[0]).toBe("n_match");
		expect(result?.ranking[0]).toEqual(expect.objectContaining({
			nodeId: "n_match",
			reasons: expect.objectContaining({ query: expect.any(Number), importance: expect.any(Number), kind: expect.any(Number) }),
		}));
		expect(result?.candidateNodeCount).toBe(2);
	});

	test("returns candidate edge ids for trigger/internal metadata", () => {
		const a = node("a", "goal", "batch legend", "display labels", 0.9);
		const b = node("b", "resolution", "labels fixed", "non-abbreviated", 0.8);
		const outside = node("outside", "issue", "unrelated", "billing", 0.1);
		const result = retrieveTopology(
			{ ...DEFAULT_INPUT, candidateNodeLimit: 2, outputNodeLimit: 1, outputEdgeLimit: 1 },
			graph({
				nodes: [a, b, outside],
				edges: [edge("e_ab", "a", "b", "fixed_by"), edge("e_out", "b", "outside", "depends_on")],
			}),
		);

		expect(result?.candidateNodeIds).toEqual(expect.arrayContaining(["a", "b"]));
		expect(result?.candidateEdgeIds).toContain("e_ab");
		expect(result?.candidateEdgeIds).not.toContain("e_out");
	});
```

- [ ] **Step 2: Run the retrieval tests and verify failure**

Run:

```bash
bun test apps/server/src/session-topology-retrieval.test.ts
```

Expected: FAIL because `rankedCandidateNodeIds`, `ranking`, `candidateNodeCount`, `candidateNodeIds`, and `candidateEdgeIds` do not exist yet.

- [ ] **Step 3: Extend retrieval result types and scoring helper**

In `apps/server/src/session-topology-retrieval.ts`, replace the existing `RetrievedTopology` interface with:

```ts
export interface RetrievedNodeRanking {
	nodeId: string;
	score: number;
	reasons: {
		query: number;
		importance: number;
		kind: number;
	};
}

export interface RetrievedTopology {
	selectedNodeIds: string[];
	selectedEdgeIds: string[];
	candidateNodeIds: string[];
	candidateEdgeIds: string[];
	rankedCandidateNodeIds: string[];
	candidateNodeCount: number;
	ranking: RetrievedNodeRanking[];
	artifacts: RetrievedArtifact[];
	omitted: { nodeCount: number; edgeCount: number; reason: string };
}
```

Replace `scoreNode()` with a pair of helpers:

```ts
function scoreNodeParts(node: SessionContextNode, queryTokens: string[]): RetrievedNodeRanking["reasons"] {
	return {
		query: textMatchScore(queryTokens, node),
		importance: clamp01(node.importance),
		kind: KIND_WEIGHTS[node.kind] ?? 0.5,
	};
}

function finalScore(parts: RetrievedNodeRanking["reasons"]): number {
	return 0.45 * parts.query + 0.30 * parts.importance + 0.25 * parts.kind;
}
```

In `retrieveTopology()`, replace the existing sorted/candidates section with:

```ts
	const ranked = graph.nodes
		.map((node) => {
			const reasons = scoreNodeParts(node, queryTokens);
			return { node, score: finalScore(reasons), reasons };
		})
		.sort((a, b) => b.score - a.score);
	const candidates = ranked.slice(0, input.candidateNodeLimit);
	const rankedCandidateNodeIds = candidates.map((item) => item.node.id);
	const candidateIds = new Set(rankedCandidateNodeIds);
	const expanded = expandNeighbors(candidateIds, graph, input.expansionHops);
	const orderedExpanded = graph.nodes.filter((node) => expanded.has(node.id));
	const selectedNodes = orderedExpanded.slice(0, input.outputNodeLimit);
	const selectedNodeIds = selectedNodes.map((node) => node.id);
	const selectedSet = new Set(selectedNodeIds);
	const candidateEdgeIds = graph.edges
		.filter((edge) => candidateIds.has(edge.sourceNodeId) && candidateIds.has(edge.targetNodeId))
		.map((edge) => edge.id);
```

In the returned object, add:

```ts
		candidateNodeIds: rankedCandidateNodeIds,
		candidateEdgeIds,
		rankedCandidateNodeIds,
		candidateNodeCount: candidates.length,
		ranking: candidates.map((item) => ({ nodeId: item.node.id, score: item.score, reasons: item.reasons })),
```

- [ ] **Step 4: Run retrieval tests and verify pass**

Run:

```bash
bun test apps/server/src/session-topology-retrieval.test.ts
```

Expected: PASS.

---

### Task 2: Add rerank config parsing

**Files:**
- Create: `apps/server/src/config-topology-rerank.ts`
- Test: `apps/server/src/config-topology-rerank.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `apps/server/src/config-topology-rerank.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { DEFAULT_TOPOLOGY_RERANK_CONFIG, getTopologyRerankConfig } from "./config-topology-rerank.ts";

describe("getTopologyRerankConfig", () => {
	test("returns defaults when env is empty", () => {
		expect(getTopologyRerankConfig({})).toEqual(DEFAULT_TOPOLOGY_RERANK_CONFIG);
	});

	test("parses valid env overrides", () => {
		expect(getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_ENABLED: "false",
			OMP_DECK_TOPOLOGY_RERANK_ROLE: "custom_reranker",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT: "25",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES: "32",
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "0.4",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "45000",
		})).toEqual({
			enabled: false,
			rerankModelRole: "custom_reranker",
			minContextPercent: 25,
			minCandidateNodes: 32,
			localConfidenceBelow: 0.4,
			timeoutMs: 45_000,
		});
	});

	test("falls back for invalid booleans and numbers", () => {
		const config = getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_ENABLED: "yes",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT: "NaN",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES: "-1",
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "abc",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "0",
		});
		expect(config).toEqual(DEFAULT_TOPOLOGY_RERANK_CONFIG);
	});

	test("clamps confidence and timeout to safe bounds", () => {
		expect(getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "1.5",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "999999",
		}).localConfidenceBelow).toBe(1);
		expect(getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "1.5",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "999999",
		}).timeoutMs).toBe(120_000);
	});
});
```

- [ ] **Step 2: Run config tests and verify failure**

Run:

```bash
bun test apps/server/src/config-topology-rerank.test.ts
```

Expected: FAIL because `config-topology-rerank.ts` does not exist.

- [ ] **Step 3: Implement config parser**

Create `apps/server/src/config-topology-rerank.ts`:

```ts
export interface TopologyRerankConfig {
	enabled: boolean;
	rerankModelRole: string;
	minContextPercent: number;
	minCandidateNodes: number;
	localConfidenceBelow: number;
	timeoutMs: number;
}

export const DEFAULT_TOPOLOGY_RERANK_CONFIG: TopologyRerankConfig = {
	enabled: true,
	rerankModelRole: "topology_query_reranker",
	minContextPercent: 12,
	minCandidateNodes: 16,
	localConfidenceBelow: 0.72,
	timeoutMs: 30_000,
};

type EnvLike = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function getTopologyRerankConfig(env: EnvLike = process.env): TopologyRerankConfig {
	const defaults = DEFAULT_TOPOLOGY_RERANK_CONFIG;
	const role = env.OMP_DECK_TOPOLOGY_RERANK_ROLE?.trim();
	const confidence = parseNonNegativeNumber(env.OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW, defaults.localConfidenceBelow);
	const timeout = parsePositiveInteger(env.OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS, defaults.timeoutMs);
	return {
		enabled: parseBoolean(env.OMP_DECK_TOPOLOGY_RERANK_ENABLED, defaults.enabled),
		rerankModelRole: role ? role : defaults.rerankModelRole,
		minContextPercent: parseNonNegativeNumber(env.OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT, defaults.minContextPercent),
		minCandidateNodes: parsePositiveInteger(env.OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES, defaults.minCandidateNodes),
		localConfidenceBelow: clamp(confidence, 0, 1),
		timeoutMs: clamp(timeout, 1_000, 120_000),
	};
}
```

- [ ] **Step 4: Run config tests and verify pass**

Run:

```bash
bun test apps/server/src/config-topology-rerank.test.ts
```

Expected: PASS.

---

### Task 3: Add strict rerank patch layer

**Files:**
- Create: `apps/server/src/topology-reranker.ts`
- Test: `apps/server/src/topology-reranker.test.ts`

- [ ] **Step 1: Write failing reranker tests**

Create `apps/server/src/topology-reranker.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionContextEdge, SessionContextGraphResponse, SessionContextNode } from "@omp-deck/protocol";

import type { RetrievedTopology } from "./session-topology-retrieval.ts";
import {
	applyRerankPatch,
	buildTopologyRerankRequest,
	parseRerankPatch,
	rerankTopologyWithExternalApi,
	shouldExternalRerank,
	validateRerankPatch,
	type TopologyRerankModelClient,
} from "./topology-reranker.ts";

function node(id: string, title = id): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind: "goal",
		title,
		body: `body ${title}`,
		compressedBody: `compressed ${title}`,
		importance: 0.9,
		createdAt: "",
		sourceMessageId: `m_${id}`,
		sourceTurnIndex: 1,
		metadata: { confidence: 0.9 },
	};
}

function edge(id: string, sourceNodeId: string, targetNodeId: string): SessionContextEdge {
	return {
		id,
		sessionId: "s1",
		sourceNodeId,
		targetNodeId,
		relation: "depends_on",
		weight: 0.9,
		metadata: {},
	};
}

const local: RetrievedTopology = {
	selectedNodeIds: ["a", "b", "c"],
	selectedEdgeIds: ["e_ab"],
	candidateNodeIds: ["a", "b", "c", "d"],
	candidateEdgeIds: ["e_ab", "e_cd"],
	rankedCandidateNodeIds: ["d", "b", "a", "c"],
	candidateNodeCount: 4,
	ranking: [
		{ nodeId: "d", score: 0.95, reasons: { query: 1, importance: 0.9, kind: 0.9 } },
		{ nodeId: "b", score: 0.8, reasons: { query: 0.8, importance: 0.8, kind: 0.9 } },
		{ nodeId: "a", score: 0.7, reasons: { query: 0.5, importance: 0.9, kind: 0.9 } },
		{ nodeId: "c", score: 0.6, reasons: { query: 0.2, importance: 0.9, kind: 0.9 } },
	],
	artifacts: [{ kind: "file", ref: "a.ts", nodeId: "a", label: "a.ts" }],
	omitted: { nodeCount: 1, edgeCount: 1, reason: "budget" },
};

const graph: SessionContextGraphResponse = {
	sessionId: "s1",
	nodes: [node("a"), node("b"), node("c"), node("d")],
	edges: [edge("e_ab", "a", "b"), edge("e_cd", "c", "d")],
	artifacts: [],
	totalNodes: 4,
	truncated: false,
};

describe("shouldExternalRerank", () => {
	test("requires enabled config and context threshold", () => {
		expect(shouldExternalRerank({ enabled: false, contextPercent: 99, candidateNodeCount: 99, localTopScore: 0, minContextPercent: 12, minCandidateNodes: 16, localConfidenceBelow: 0.72 })).toBe(false);
		expect(shouldExternalRerank({ enabled: true, contextPercent: 11, candidateNodeCount: 99, localTopScore: 0, minContextPercent: 12, minCandidateNodes: 16, localConfidenceBelow: 0.72 })).toBe(false);
	});

	test("triggers on many candidates or low local score", () => {
		expect(shouldExternalRerank({ enabled: true, contextPercent: 12, candidateNodeCount: 16, localTopScore: 0.9, minContextPercent: 12, minCandidateNodes: 16, localConfidenceBelow: 0.72 })).toBe(true);
		expect(shouldExternalRerank({ enabled: true, contextPercent: 12, candidateNodeCount: 2, localTopScore: 0.2, minContextPercent: 12, minCandidateNodes: 16, localConfidenceBelow: 0.72 })).toBe(true);
		expect(shouldExternalRerank({ enabled: true, contextPercent: 12, candidateNodeCount: 2, localTopScore: 0.9, minContextPercent: 12, minCandidateNodes: 16, localConfidenceBelow: 0.72 })).toBe(false);
	});
});

describe("buildTopologyRerankRequest", () => {
	test("builds sanitized candidate request from the local selected subgraph", () => {
		const request = buildTopologyRerankRequest({ query: "rerank", graph, local, nodeLimit: 2, edgeLimit: 3 });
		expect(request.task).toBe("query_rerank");
		expect(request.candidateNodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
		expect(JSON.stringify(request)).not.toContain("importance");
		expect(JSON.stringify(request)).not.toContain("confidence");
		expect(JSON.stringify(request)).not.toContain("weight");
		expect(request.budget).toEqual({ nodeLimit: 2, edgeLimit: 3 });
	});
});

describe("parseRerankPatch", () => {
	test("accepts and deduplicates strict patch objects", () => {
		expect(parseRerankPatch({ keepNodeIds: ["a", "a"], keepEdgeIds: ["e_ab"], demoteNodeIds: ["c"], reason: "ok" })).toEqual({
			keepNodeIds: ["a"],
			keepEdgeIds: ["e_ab"],
			demoteNodeIds: ["c"],
			reason: "ok",
		});
	});

	test("rejects unknown keys and non-string arrays", () => {
		expect(parseRerankPatch({ keepNodeIds: ["a"], keepEdgeIds: [], demoteNodeIds: [], extra: true })).toBeUndefined();
		expect(parseRerankPatch({ keepNodeIds: [1], keepEdgeIds: [], demoteNodeIds: [] })).toBeUndefined();
	});
});

describe("validateRerankPatch", () => {
	test("rejects unknown ids and oversized keep arrays", () => {
		expect(validateRerankPatch({ patch: { keepNodeIds: ["missing"], keepEdgeIds: [], demoteNodeIds: [] }, graph, local, outputNodeLimit: 3, outputEdgeLimit: 3 })).toBeUndefined();
		expect(validateRerankPatch({ patch: { keepNodeIds: ["a", "b", "c", "d"], keepEdgeIds: [], demoteNodeIds: [] }, graph, local, outputNodeLimit: 3, outputEdgeLimit: 3 })).toBeUndefined();
	});

	test("normalizes keep over demote conflicts", () => {
		expect(validateRerankPatch({ patch: { keepNodeIds: ["b"], keepEdgeIds: [], demoteNodeIds: ["b", "c"] }, graph, local, outputNodeLimit: 3, outputEdgeLimit: 3 })).toEqual({
			keepNodeIds: ["b"],
			keepEdgeIds: [],
			demoteNodeIds: ["c"],
		});
	});
});

describe("applyRerankPatch", () => {
	test("orders keep nodes first, appends remaining local selected nodes, and filters edges by surviving endpoints", () => {
		const result = applyRerankPatch({ local, graph, patch: { keepNodeIds: ["b"], keepEdgeIds: ["e_cd"], demoteNodeIds: ["c"] }, outputNodeLimit: 3, outputEdgeLimit: 3 });
		expect(result.selectedNodeIds).toEqual(["b", "a"]);
		expect(result.selectedEdgeIds).toEqual(["e_ab"]);
	});

	test("does not allow a patch to empty the selection", () => {
		const result = applyRerankPatch({ local, graph, patch: { keepNodeIds: [], keepEdgeIds: [], demoteNodeIds: ["a", "b", "c", "d"] }, outputNodeLimit: 3, outputEdgeLimit: 3 });
		expect(result).toBe(local);
	});
});

describe("rerankTopologyWithExternalApi", () => {
	test("returns reranked topology for a valid client patch", async () => {
		const client: TopologyRerankModelClient = { rerankTopology: async () => ({ keepNodeIds: ["b"], keepEdgeIds: [], demoteNodeIds: ["c"] }) };
		const result = await rerankTopologyWithExternalApi({ client, modelRole: "topology_query_reranker", timeoutMs: 1000, query: "rerank", graph, local, outputNodeLimit: 3, outputEdgeLimit: 3 });
		expect(result?.selectedNodeIds[0]).toBe("b");
	});

	test("returns undefined on client failure", async () => {
		const client: TopologyRerankModelClient = { rerankTopology: async () => { throw new Error("network"); } };
		const result = await rerankTopologyWithExternalApi({ client, modelRole: "topology_query_reranker", timeoutMs: 1000, query: "rerank", graph, local, outputNodeLimit: 3, outputEdgeLimit: 3 });
		expect(result).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run reranker tests and verify failure**

Run:

```bash
bun test apps/server/src/topology-reranker.test.ts
```

Expected: FAIL because `topology-reranker.ts` does not exist.

- [ ] **Step 3: Implement reranker helpers**

Create `apps/server/src/topology-reranker.ts`:

```ts
import type { SessionContextGraphResponse } from "@omp-deck/protocol";

import type { RetrievedTopology } from "./session-topology-retrieval.ts";

export interface TopologyRerankRequest {
	task: "query_rerank";
	query: string;
	candidateNodes: Array<{ id: string; kind: string; title: string; body: string }>;
	candidateEdges: Array<{ id: string; sourceNodeId: string; relation: string; targetNodeId: string }>;
	budget: { nodeLimit: number; edgeLimit: number };
}

export interface RerankPatch {
	keepNodeIds: string[];
	keepEdgeIds: string[];
	demoteNodeIds: string[];
	reason?: string;
}

export interface TopologyRerankModelClient {
	rerankTopology(input: { modelRole: string; request: TopologyRerankRequest; timeoutMs: number }): Promise<unknown>;
}

export function shouldExternalRerank(input: {
	enabled: boolean;
	contextPercent?: number | null;
	candidateNodeCount: number;
	localTopScore: number;
	minContextPercent: number;
	minCandidateNodes: number;
	localConfidenceBelow: number;
}): boolean {
	if (!input.enabled) return false;
	if ((input.contextPercent ?? 0) < input.minContextPercent) return false;
	return input.candidateNodeCount >= input.minCandidateNodes || input.localTopScore < input.localConfidenceBelow;
}

export function buildTopologyRerankRequest(input: {
	query: string;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	nodeLimit: number;
	edgeLimit: number;
}): TopologyRerankRequest {
	const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
	const selectedSet = new Set(input.local.selectedNodeIds);
	const edgeSet = new Set(input.local.selectedEdgeIds);
	return {
		task: "query_rerank",
		query: input.query,
		candidateNodes: input.local.selectedNodeIds
			.map((id) => nodeById.get(id))
			.filter((node): node is NonNullable<typeof node> => Boolean(node) && selectedSet.has(node.id))
			.map((node) => ({ id: node.id, kind: node.kind, title: node.title, body: node.compressedBody || node.body })),
		candidateEdges: input.graph.edges
			.filter((edge) => edgeSet.has(edge.id))
			.map((edge) => ({ id: edge.id, sourceNodeId: edge.sourceNodeId, relation: edge.relation, targetNodeId: edge.targetNodeId })),
		budget: { nodeLimit: input.nodeLimit, edgeLimit: input.edgeLimit },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		if (!result.includes(item)) result.push(item);
	}
	return result;
}

export function parseRerankPatch(raw: unknown): RerankPatch | undefined {
	if (!isRecord(raw)) return undefined;
	const allowed = new Set(["keepNodeIds", "keepEdgeIds", "demoteNodeIds", "reason"]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) return undefined;
	}
	const keepNodeIds = stringArray(raw.keepNodeIds ?? []);
	const keepEdgeIds = stringArray(raw.keepEdgeIds ?? []);
	const demoteNodeIds = stringArray(raw.demoteNodeIds ?? []);
	if (!keepNodeIds || !keepEdgeIds || !demoteNodeIds) return undefined;
	if (raw.reason !== undefined && typeof raw.reason !== "string") return undefined;
	const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 500) : undefined;
	return reason === undefined ? { keepNodeIds, keepEdgeIds, demoteNodeIds } : { keepNodeIds, keepEdgeIds, demoteNodeIds, reason };
}

export function validateRerankPatch(input: {
	patch: RerankPatch;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	outputNodeLimit: number;
	outputEdgeLimit: number;
}): RerankPatch | undefined {
	if (input.patch.keepNodeIds.length > input.outputNodeLimit) return undefined;
	if (input.patch.keepEdgeIds.length > input.outputEdgeLimit) return undefined;
	const selectedNodes = new Set(input.local.selectedNodeIds);
	const selectedEdges = new Set(input.local.selectedEdgeIds);
	for (const id of [...input.patch.keepNodeIds, ...input.patch.demoteNodeIds]) {
		if (!selectedNodes.has(id)) return undefined;
	}
	for (const id of input.patch.keepEdgeIds) {
		if (!selectedEdges.has(id)) return undefined;
		const edge = input.graph.edges.find((candidate) => candidate.id === id);
		if (!edge || !selectedNodes.has(edge.sourceNodeId) || !selectedNodes.has(edge.targetNodeId)) return undefined;
	}
	const keep = new Set(input.patch.keepNodeIds);
	const demoteNodeIds = input.patch.demoteNodeIds.filter((id) => !keep.has(id));
	return input.patch.reason === undefined
		? { keepNodeIds: input.patch.keepNodeIds, keepEdgeIds: input.patch.keepEdgeIds, demoteNodeIds }
		: { keepNodeIds: input.patch.keepNodeIds, keepEdgeIds: input.patch.keepEdgeIds, demoteNodeIds, reason: input.patch.reason };
}

export function applyRerankPatch(input: {
	local: RetrievedTopology;
	graph: SessionContextGraphResponse;
	patch: RerankPatch;
	outputNodeLimit: number;
	outputEdgeLimit: number;
}): RetrievedTopology {
	const demote = new Set(input.patch.demoteNodeIds);
	const selected: string[] = [];
	for (const id of input.patch.keepNodeIds) {
		if (!selected.includes(id)) selected.push(id);
	}
	for (const id of input.local.selectedNodeIds) {
		if (selected.length >= input.outputNodeLimit) break;
		if (demote.has(id) || selected.includes(id)) continue;
		selected.push(id);
	}
	if (selected.length === 0) return input.local;
	const selectedSet = new Set(selected);
	const edgeById = new Map(input.graph.edges.map((edge) => [edge.id, edge]));
	const edges: string[] = [];
	for (const id of input.patch.keepEdgeIds) {
		const edge = edgeById.get(id);
		if (!edge || !selectedSet.has(edge.sourceNodeId) || !selectedSet.has(edge.targetNodeId)) continue;
		if (!edges.includes(id)) edges.push(id);
	}
	for (const id of input.local.selectedEdgeIds) {
		if (edges.length >= input.outputEdgeLimit) break;
		const edge = edgeById.get(id);
		if (!edge || !selectedSet.has(edge.sourceNodeId) || !selectedSet.has(edge.targetNodeId)) continue;
		if (!edges.includes(id)) edges.push(id);
	}
	return {
		...input.local,
		selectedNodeIds: selected,
		selectedEdgeIds: edges.slice(0, input.outputEdgeLimit),
		artifacts: input.local.artifacts.filter((artifact) => !artifact.nodeId || selectedSet.has(artifact.nodeId)),
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`topology rerank timeout after ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export async function rerankTopologyWithExternalApi(input: {
	client: TopologyRerankModelClient;
	modelRole: string;
	timeoutMs: number;
	query: string;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	outputNodeLimit: number;
	outputEdgeLimit: number;
}): Promise<RetrievedTopology | undefined> {
	try {
		const request = buildTopologyRerankRequest({ query: input.query, graph: input.graph, local: input.local, nodeLimit: input.outputNodeLimit, edgeLimit: input.outputEdgeLimit });
		const raw = await withTimeout(input.client.rerankTopology({ modelRole: input.modelRole, request, timeoutMs: input.timeoutMs }), input.timeoutMs);
		const parsed = parseRerankPatch(raw);
		if (!parsed) return undefined;
		const valid = validateRerankPatch({ patch: parsed, graph: input.graph, local: input.local, outputNodeLimit: input.outputNodeLimit, outputEdgeLimit: input.outputEdgeLimit });
		if (!valid) return undefined;
		return applyRerankPatch({ local: input.local, graph: input.graph, patch: valid, outputNodeLimit: input.outputNodeLimit, outputEdgeLimit: input.outputEdgeLimit });
	} catch {
		return undefined;
	}
}
```

- [ ] **Step 4: Run reranker tests and verify pass**

Run:

```bash
bun test apps/server/src/topology-reranker.test.ts
```

Expected: PASS.

---

### Task 4: Convert stored query focus to async and integrate optional rerank

**Files:**
- Modify: `apps/server/src/session-context.ts`
- Test: `apps/server/src/session-context.test.ts`

- [ ] **Step 1: Write failing DB-backed rerank integration tests**

`apps/server/src/session-context.test.ts` currently does not import or exercise `getStoredQueryTopologyFocus()`. Add it to the existing lower context-replacement import by changing:

```ts
import { renderPackAsCompactFocus, renderTopologyGraphAsCompactFocus, shouldReplaceContext } from "./session-context.ts";
```

to:

```ts
import { getStoredQueryTopologyFocus, renderPackAsCompactFocus, renderTopologyGraphAsCompactFocus, shouldReplaceContext } from "./session-context.ts";
```

Add these DB-backed tests inside `describe("context replacement", ...)`. The red condition is missing rerank behavior/API, not Promise-vs-string semantics: `await` on a sync string is legal JavaScript and is not a valid red test.

```ts
	test("getStoredQueryTopologyFocus applies an injected rerank patch and keeps focus clean", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "s_rerank.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "s_rerank", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "topology rerank plan" }] } }),
			JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "external API patch validation" }] } }),
		].join("\n"));
		await rebuildSessionContextFromFile({ sessionId: "s_rerank", sessionFile });
		const graph = getSessionContextGraph("s_rerank", 200);
		const keep = graph.nodes.find((node) => node.body.includes("external API patch validation"));
		expect(keep).toBeDefined();

		const focus = await getStoredQueryTopologyFocus({
			sessionId: "s_rerank",
			query: "topology",
			contextPercent: 99,
			rerankClient: { rerankTopology: async () => ({ keepNodeIds: [keep!.id], keepEdgeIds: [], demoteNodeIds: [] }) },
		});

		const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
		expect(json).toBeDefined();
		const payload = JSON.parse(json!);
		expect(payload.nodes[0].id).toBe(keep!.id);
		expect(JSON.stringify(payload)).not.toContain("score");
		expect(JSON.stringify(payload)).not.toContain("reasons");
		expect(JSON.stringify(payload)).not.toContain("importance");
	});

	test("getStoredQueryTopologyFocus falls back to local focus when injected rerank patch is invalid", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "s_invalid_rerank.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "s_invalid_rerank", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "topology rerank fallback local baseline" }] } }),
		].join("\n"));
		await rebuildSessionContextFromFile({ sessionId: "s_invalid_rerank", sessionFile });

		const localFocus = await getStoredQueryTopologyFocus({ sessionId: "s_invalid_rerank", query: "topology", contextPercent: 99, rerankClient: { rerankTopology: async () => undefined } });
		const fallbackFocus = await getStoredQueryTopologyFocus({ sessionId: "s_invalid_rerank", query: "topology", contextPercent: 99, rerankClient: { rerankTopology: async () => ({ keepNodeIds: ["missing"], keepEdgeIds: [], demoteNodeIds: [] }) } });

		expect(fallbackFocus).toBe(localFocus);
	});
```

- [ ] **Step 2: Run context tests and verify failure**

Run:

```bash
bun test apps/server/src/session-context.test.ts
```

Expected: FAIL because `getStoredQueryTopologyFocus()` does not accept or apply `rerankClient`, so the accepted-patch test still returns local baseline ordering instead of the injected keep node first.

- [ ] **Step 3: Update `session-context.ts` imports and async getter**

At the top of `apps/server/src/session-context.ts`, replace:

```ts
import { retrieveTopology, type RetrievedTopology } from "./session-topology-retrieval.ts";
```

with:

```ts
import { getTopologyRerankConfig } from "./config-topology-rerank.ts";
import { retrieveTopology, type RetrievedTopology } from "./session-topology-retrieval.ts";
import { rerankTopologyWithExternalApi, shouldExternalRerank, type TopologyRerankModelClient } from "./topology-reranker.ts";
```

Add a no-op client near `GetStoredQueryTopologyFocusInput`:

```ts
const DISABLED_RERANK_CLIENT: TopologyRerankModelClient = {
	async rerankTopology() {
		return undefined;
	},
};
```

Extend the input interface:

```ts
export interface GetStoredQueryTopologyFocusInput {
	sessionId: string;
	query: string;
	contextPercent?: number | null;
	rerankClient?: TopologyRerankModelClient;
}
```

Replace `getStoredQueryTopologyFocus()` with:

```ts
export async function getStoredQueryTopologyFocus(input: GetStoredQueryTopologyFocusInput): Promise<string> {
	const graph = getSessionContextGraph(input.sessionId, 200);
	if (graph.nodes.length === 0) return "";
	const outputNodeLimit = 10;
	const outputEdgeLimit = 18;
	const retrieved = retrieveTopology(
		{
			sessionId: input.sessionId,
			query: input.query,
			candidateNodeLimit: 50,
			expansionHops: 1,
			outputNodeLimit,
			outputEdgeLimit,
			outputArtifactLimit: 12,
		},
		graph,
	);
	if (!retrieved) return "";

	let selected = retrieved;
	const config = getTopologyRerankConfig();
	const localTopScore = retrieved.ranking[0]?.score ?? 0;
	if (shouldExternalRerank({
		enabled: config.enabled,
		contextPercent: input.contextPercent,
		candidateNodeCount: retrieved.candidateNodeCount,
		localTopScore,
		minContextPercent: config.minContextPercent,
		minCandidateNodes: config.minCandidateNodes,
		localConfidenceBelow: config.localConfidenceBelow,
	})) {
		const reranked = await rerankTopologyWithExternalApi({
			client: input.rerankClient ?? DISABLED_RERANK_CLIENT,
			modelRole: config.rerankModelRole,
			timeoutMs: config.timeoutMs,
			query: input.query,
			graph,
			local: retrieved,
			outputNodeLimit,
			outputEdgeLimit,
		});
		if (reranked) selected = reranked;
	}

	return renderRetrievedTopologyAsFocus(input.sessionId, input.query, selected);
}
```

This keeps external integration dormant until a real client is provided. It still converts the API to async and wires the fallback-safe rerank path.

- [ ] **Step 4: Run context tests and verify pass**

Run:

```bash
bun test apps/server/src/session-context.test.ts
```

Expected: PASS.

---

### Task 5: Await async focus getter in both bridges

**Files:**
- Modify: `apps/server/src/bridge/in-process.ts`
- Modify: `apps/server/src/bridge/rpc.ts`

- [ ] **Step 1: Update in-process bridge compact callsite**

In `apps/server/src/bridge/in-process.ts`, replace:

```ts
			const focus = getStoredQueryTopologyFocus({ sessionId: this.sessionId, query: currentQuery, contextPercent: before.percent ?? null });
```

with:

```ts
			const focus = await getStoredQueryTopologyFocus({ sessionId: this.sessionId, query: currentQuery, contextPercent: before.percent ?? null });
```

- [ ] **Step 2: Update RPC bridge compact callsite**

In `apps/server/src/bridge/rpc.ts`, replace:

```ts
			const focus = getStoredQueryTopologyFocus({ sessionId: this.sessionId, query: currentQuery, contextPercent: usage.percent ?? null });
```

with:

```ts
			const focus = await getStoredQueryTopologyFocus({ sessionId: this.sessionId, query: currentQuery, contextPercent: usage.percent ?? null });
```

- [ ] **Step 3: Run server typecheck to catch missed sync callers**

Run:

```bash
bun run --filter '@omp-deck/server' typecheck
```

Expected: PASS. If it fails with `Promise<string>` errors, update every direct caller to `await getStoredQueryTopologyFocus(...)` and rerun.

---

### Task 6: Add rerank success/fallback integration tests

**Files:**
- Modify: `apps/server/src/session-context.test.ts`

- [ ] **Step 1: Add an integration test for accepted rerank patch**

Add this test inside `describe("context replacement", ...)` after the async local focus test:

```ts
	test("getStoredQueryTopologyFocus applies a valid rerank patch and keeps focus clean", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "s_rerank.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "s_rerank", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "topology rerank plan" }] } }),
			JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "external API patch validation" }] } }),
		].join("\n"));
		await rebuildSessionContextFromFile({ sessionId: "s_rerank", sessionFile });
		const graph = getSessionContextGraph("s_rerank", 200);
		const keep = graph.nodes.find((node) => node.body.includes("external API patch validation"));
		expect(keep).toBeDefined();

		const focus = await getStoredQueryTopologyFocus({
			sessionId: "s_rerank",
			query: "topology",
			contextPercent: 99,
			rerankClient: { rerankTopology: async () => ({ keepNodeIds: [keep!.id], keepEdgeIds: [], demoteNodeIds: [] }) },
		});

		const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
		expect(json).toBeDefined();
		const payload = JSON.parse(json!);
		expect(payload.nodes[0].id).toBe(keep!.id);
		expect(JSON.stringify(payload)).not.toContain("score");
		expect(JSON.stringify(payload)).not.toContain("reasons");
	});
```

- [ ] **Step 2: Add an integration test for invalid patch fallback**

Add this test after the accepted patch test:

```ts
	test("getStoredQueryTopologyFocus falls back to local focus when rerank patch is invalid", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "s_invalid_rerank.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "s_invalid_rerank", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "topology rerank fallback local baseline" }] } }),
		].join("\n"));
		await rebuildSessionContextFromFile({ sessionId: "s_invalid_rerank", sessionFile });

		const localFocus = await getStoredQueryTopologyFocus({ sessionId: "s_invalid_rerank", query: "topology", contextPercent: 99, rerankClient: { rerankTopology: async () => undefined } });
		const fallbackFocus = await getStoredQueryTopologyFocus({ sessionId: "s_invalid_rerank", query: "topology", contextPercent: 99, rerankClient: { rerankTopology: async () => ({ keepNodeIds: ["missing"], keepEdgeIds: [], demoteNodeIds: [] }) } });

		expect(fallbackFocus).toBe(localFocus);
	});
```

- [ ] **Step 3: Run context tests and verify pass**

Run:

```bash
bun test apps/server/src/session-context.test.ts
```

Expected: PASS.

---

### Task 7: Final targeted verification

**Files:**
- No source edits unless verification exposes a compile or test failure.

- [ ] **Step 1: Run topology retrieval, reranker, config, and context tests**

Run:

```bash
bun test \
  apps/server/src/session-topology-retrieval.test.ts \
  apps/server/src/config-topology-rerank.test.ts \
  apps/server/src/topology-reranker.test.ts \
  apps/server/src/session-context.test.ts \
  apps/server/src/context-savings-tracker.test.ts
```

Expected: all listed tests pass with `0 fail`.

- [ ] **Step 2: Run server typecheck**

Run:

```bash
bun run --filter '@omp-deck/server' typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run web typecheck**

Run:

```bash
bun run --filter '@omp-deck/web' typecheck
```

Expected: exit 0. This catches shared protocol/type ripple even though no web code should change.

- [ ] **Step 4: Run web build**

Run:

```bash
bun run --filter '@omp-deck/web' build
```

Expected: exit 0.

- [ ] **Step 5: Check changed files**

Run:

```bash
git status --short
```

Expected changed files are limited to:

```text
M apps/server/src/session-topology-retrieval.ts
M apps/server/src/session-topology-retrieval.test.ts
A apps/server/src/config-topology-rerank.ts
A apps/server/src/config-topology-rerank.test.ts
A apps/server/src/topology-reranker.ts
A apps/server/src/topology-reranker.test.ts
M apps/server/src/session-context.ts
M apps/server/src/session-context.test.ts
M apps/server/src/bridge/in-process.ts
M apps/server/src/bridge/rpc.ts
```

If other files appear, inspect them and either justify them in the final note or revert accidental changes.

## Self-review notes

- Spec coverage: covers existing retrieval metadata expansion, external rerank trigger/config, strict patch validation, async focus getter conversion, required bridge awaits, and clean focus invariants.
- Placeholder scan: no placeholder implementation tasks; each code-bearing step includes concrete code.
- Type consistency: `RetrievedTopology`, `TopologyRerankModelClient`, `TopologyRerankRequest`, and `RerankPatch` names are consistent across tasks.
- Current behavior anchor: the plan explicitly preserves graph/storage order for local baseline `selectedNodeIds`; ranked candidate ids are trigger/internal metadata only, not rerank request or application scope.
