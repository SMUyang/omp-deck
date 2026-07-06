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
