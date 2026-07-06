import { describe, expect, test } from "bun:test";

import { getTopologyRerankConfig } from "./config-topology-rerank.ts";

describe("getTopologyRerankConfig", () => {
	test("returns defaults when env is empty", () => {
		const config = getTopologyRerankConfig({});
		expect(config.enabled).toBe(true);
		expect(config.rerankModelRole).toBe("topology_query_reranker");
		expect(config.provider).toBe("model_role");
		expect(config.http.baseUrl).toBe("");
	});

	test("parses existing knobs and provider", () => {
		const config = getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_ENABLED: "false",
			OMP_DECK_TOPOLOGY_RERANK_ROLE: "custom_reranker",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT: "25",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES: "32",
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "0.4",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "45000",
		});
		expect(config.enabled).toBe(false);
		expect(config.rerankModelRole).toBe("custom_reranker");
		expect(config.minContextPercent).toBe(25);
		expect(config.minCandidateNodes).toBe(32);
		expect(config.localConfidenceBelow).toBe(0.4);
		expect(config.timeoutMs).toBe(45_000);
		expect(config.provider).toBe("model_role");
	});

	test("parses provider=http and HTTP endpoint knobs", () => {
		const config = getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_PROVIDER: "http",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL: "https://api.example.com",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_ENDPOINT_PATH: "/v1/rerank",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_TIMEOUT_MS: "12000",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD: "0.5",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CANDIDATE_NODES: "8",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CONTEXT_PERCENT: "20",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_AUTH_HEADER_NAME: "X-API-Key",
		});
		expect(config.provider).toBe("http");
		expect(config.http.baseUrl).toBe("https://api.example.com");
		expect(config.http.endpointPath).toBe("/v1/rerank");
		expect(config.http.timeoutMs).toBe(12_000);
		expect(config.http.confidenceThreshold).toBe(0.5);
		expect(config.http.minCandidateNodes).toBe(8);
		expect(config.http.minContextPercent).toBe(20);
		expect(config.http.authHeaderName).toBe("X-API-Key");
	});

	test("falls back to defaults on invalid numbers", () => {
		const config = getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT: "NaN",
			OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES: "-1",
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "abc",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "0",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD: "2",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CANDIDATE_NODES: "-1",
			OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CONTEXT_PERCENT: "NaN",
		});
		expect(config.minContextPercent).toBe(12);
		expect(config.minCandidateNodes).toBe(16);
		expect(config.localConfidenceBelow).toBe(0.72);
		expect(config.timeoutMs).toBe(30_000);
		expect(config.http.confidenceThreshold).toBe(0.72);
		expect(config.http.minCandidateNodes).toBe(16);
		expect(config.http.minContextPercent).toBe(12);
	});

	test("falls back to model_role on invalid provider", () => {
		const config = getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_PROVIDER: "weird",
		});
		expect(config.provider).toBe("model_role");
	});

	test("clamps confidence and timeout to safe bounds", () => {
		const config = getTopologyRerankConfig({
			OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW: "1.5",
			OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS: "999999",
		});
		expect(config.localConfidenceBelow).toBe(1);
		expect(config.timeoutMs).toBe(120_000);
	});
});
