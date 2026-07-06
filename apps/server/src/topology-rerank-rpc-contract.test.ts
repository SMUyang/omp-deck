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
