import { afterEach, describe, expect, test } from "bun:test";

import type { TopologyPairRerankRequest } from "./topology-reranker.ts";
import { buildPairDocumentTexts, rerankTopologyPairsWithSiliconflow, resultsToPairRerankPatch } from "./topology-rerank-siliconflow-adapter.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const request: TopologyPairRerankRequest = {
	task: "query_pair_rerank",
	query: "keep service alive",
	candidatePairs: [
		{ pairId: "p1", user: { id: "u1", operation: "request", purpose: "keep background service", title: "Keep alive", body: "start remains alive" }, assistant: { id: "a1", operation: "answer", purpose: "detach process", title: "Detached", body: "launched detached" }, children: [{ id: "c1", childType: "test", operation: "verify", purpose: "prove persistence", body: "test passed" }] },
		{ pairId: "p2", user: { id: "u2", title: "Other", body: "change chart color" }, children: [] },
	],
	budget: { pairLimit: 1, nodeLimit: 3, childLimit: 1 },
};

describe("SiliconFlow pair rerank adapter", () => {
	test("RED: builds one labeled bounded document per pair with exact pair index mapping", () => {
		expect(buildPairDocumentTexts(request)).toEqual([
		{ pairId: "p1", text: "pair=p1; user.operation=request; user.purpose=keep background service; user.title=Keep alive; user.body=start remains alive; assistant.operation=answer; assistant.purpose=detach process; assistant.title=Detached; assistant.body=launched detached; child.1.type=test; child.1.operation=verify; child.1.purpose=prove persistence; child.1.body=test passed" },
		{ pairId: "p2", text: "pair=p2; user.title=Other; user.body=change chart color" },
	]);
	});

	test("RED: maps valid result indices by relevance and demotes remaining candidate pairs", () => {
		expect(resultsToPairRerankPatch(["p1", "p2"], [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }], 0.85)).toEqual({ keepPairIds: ["p2"], keepChildIds: [], demotePairIds: ["p1"] });
		expect(resultsToPairRerankPatch(["p1", "p2"], [{ index: 99, relevance_score: 1 }, { index: 0, relevance_score: Number.NaN }], 0.5)).toBeUndefined();
	});

	test("RED: posts pair documents model query and auth and returns undefined on failures", async () => {
		let captured: { body: unknown; authorization: string | null } | undefined;
		(globalThis as { fetch: typeof fetch }).fetch = (async (_input, init) => {
			captured = { body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") };
			return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		const result = await rerankTopologyPairsWithSiliconflow({ baseUrl: "https://api.example", endpointPath: "/rerank", apiKey: "secret", timeoutMs: 1000, model: "bge-reranker-v2-m3", relevanceThreshold: 0.5, request });
		expect(result).toEqual({ keepPairIds: ["p1"], keepChildIds: [], demotePairIds: ["p2"] });
		expect(captured).toEqual({ authorization: "Bearer secret", body: { model: "bge-reranker-v2-m3", query: "keep service alive", documents: buildPairDocumentTexts(request).map((item) => item.text), top_n: 1, return_documents: false } });

		(globalThis as { fetch: typeof fetch }).fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
		expect(await rerankTopologyPairsWithSiliconflow({ baseUrl: "https://api.example", apiKey: "", timeoutMs: 1, model: "m", relevanceThreshold: 0.5, request })).toBeUndefined();
	});
});
