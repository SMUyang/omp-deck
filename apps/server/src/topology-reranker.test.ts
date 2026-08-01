import { describe, expect, test } from "bun:test";
import type { SessionContextArtifact, SessionContextEdge, SessionContextGraphResponse, SessionContextNode } from "@omp-deck/protocol";

import type { PairRetrievalResult } from "./session-pair-retrieval.ts";
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
import { applyPairRerankPatch, buildTopologyPairRerankRequest, parsePairRerankPatch, validatePairRerankPatch } from "./topology-reranker.ts";

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

const pairGraph: SessionContextGraphResponse = {
	sessionId: "s1",
	nodes: [
		{ ...node("u1"), population: "user", nodeRole: "main", pairId: "p1", operation: "request", purpose: "keep background service", metadata: { confidence: 0.9 } },
		{ ...node("a1"), population: "assistant", nodeRole: "main", pairId: "p1", operation: "answer", purpose: "start detached", metadata: { score: 1 } },
		{ ...node("c1"), population: "assistant", nodeRole: "child", pairId: "p1", parentNodeId: "a1", childType: "test", operation: "verify", purpose: "run tests", metadata: { rank: 1 } },
		{ ...node("u2"), population: "user", nodeRole: "main", pairId: "p2", operation: "request", purpose: "other" },
		{ ...node("a2"), population: "assistant", nodeRole: "main", pairId: "p2", operation: "answer", purpose: "other" },
	],
	edges: [edge("p1-answer", "u1", "a1"), edge("p1-child", "a1", "c1"), edge("p2-answer", "u2", "a2")],
	artifacts: [{ id: "art", sessionId: "s1", nodeId: "c1", kind: "test", ref: "bun test", label: "test", metadata: {} } satisfies SessionContextArtifact],
	totalNodes: 5,
	truncated: false,
};

const pairLocal: PairRetrievalResult = {
	selectedPairIds: ["p1"], selectedNodeIds: ["u1", "a1", "c1"], selectedChildIds: ["c1"], selectedEdgeIds: ["p1-answer", "p1-child"], artifacts: [{ kind: "test", ref: "bun test", nodeId: "c1", label: "test" }],
	eligibleCounts: { userMain: 2, assistantMain: 2, children: 1 }, candidateCounts: { userMain: 2, assistantMain: 2, children: 1 }, omitted: { pairs: 1, children: 0, reason: "budget" },
	ranking: [{ unitId: "p1", score: 0.9, nodeIds: ["u1", "a1"] }, { unitId: "p2", score: 0.8, nodeIds: ["u2", "a2"] }],
};

describe("conversation pair rerank contract", () => {
	test("RED: request uses broader pair candidates and recursively excludes ranking priors", () => {
		const request = buildTopologyPairRerankRequest({ query: "background", graph: pairGraph, local: pairLocal, pairLimit: 1, nodeLimit: 3, childLimit: 1 });
		expect(request.task).toBe("query_pair_rerank");
		expect(request.candidatePairs.map((candidate) => candidate.pairId)).toEqual(["p1", "p2"]);
		const keys: string[] = [];
		const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) { for (const item of value) visit(item); return; } for (const [key, child] of Object.entries(value)) { keys.push(key); visit(child); } };
		visit(request);
		for (const forbidden of ["importance", "weight", "score", "scores", "rank", "confidence", "relevance", "cosine", "bm25", "reason", "candidateDiagnostics", "threshold", "timestamp", "metadata", "sourceMessageId", "sourceTurnIndex"]) expect(keys).not.toContain(forbidden);
	});

	test("RED: parser normalizes duplicates and rejects malformed or extra-key patches", () => {
		expect(parsePairRerankPatch({ keepPairIds: ["p1", "p1"], keepChildIds: ["c1", "c1"], demotePairIds: [] })).toEqual({ keepPairIds: ["p1"], keepChildIds: ["c1"], demotePairIds: [] });
		expect(parsePairRerankPatch({ keepPairIds: ["p1"], keepChildIds: [], demotePairIds: [], extra: true })).toBeUndefined();
		expect(parsePairRerankPatch({ keepPairIds: "p1", keepChildIds: [], demotePairIds: [] })).toBeUndefined();
	});

	test("RED: validation rejects unknown IDs oversized arrays and demoting forced child closure", () => {
		expect(validatePairRerankPatch({ patch: { keepPairIds: ["missing"], keepChildIds: [], demotePairIds: [] }, graph: pairGraph, local: pairLocal, pairLimit: 2, nodeLimit: 5, childLimit: 1 })).toBeUndefined();
		expect(validatePairRerankPatch({ patch: { keepPairIds: ["p1", "p2", "p1"], keepChildIds: [], demotePairIds: [] }, graph: pairGraph, local: pairLocal, pairLimit: 1, nodeLimit: 5, childLimit: 1 })).toBeUndefined();
		expect(validatePairRerankPatch({ patch: { keepPairIds: [], keepChildIds: ["c1"], demotePairIds: ["p1"] }, graph: pairGraph, local: pairLocal, pairLimit: 2, nodeLimit: 5, childLimit: 1 })).toBeUndefined();
	});

	test("RED: child-only keep closes upward and drops atomically when the closure cannot fit", () => {
		const patch = { keepPairIds: [], keepChildIds: ["c1"], demotePairIds: [] };
		const kept = applyPairRerankPatch({ local: pairLocal, graph: pairGraph, patch, pairLimit: 1, nodeLimit: 3, childLimit: 1, edgeLimit: 10, artifactLimit: 10 });
		expect(kept.selectedNodeIds).toEqual(["u1", "a1", "c1"]);
		expect(kept.selectedEdgeIds).toEqual(expect.arrayContaining(["p1-answer", "p1-child"]));
		expect(kept.artifacts.map((item) => item.ref)).toEqual(["bun test"]);
		const dropped = applyPairRerankPatch({ local: pairLocal, graph: pairGraph, patch, pairLimit: 1, nodeLimit: 2, childLimit: 1, edgeLimit: 10, artifactLimit: 10 });
		expect(dropped.selectedNodeIds).toEqual([]);
	});
});
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
