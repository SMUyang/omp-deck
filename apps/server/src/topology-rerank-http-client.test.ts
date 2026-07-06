import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	buildRerankHttpHeaders,
	buildRerankHttpRequest,
	parseRerankHttpResponse,
	rerankTopologyWithHttp,
} from "./topology-rerank-http-client.ts";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("buildRerankHttpRequest", () => {
	test("serializes the deck-internal TopologyRerankRequest shape", () => {
		const body = buildRerankHttpRequest({
			query: "compile errors",
			candidateNodes: [
				{ id: "n1", kind: "goal", title: "Goal", body: "Build graph" },
				{ id: "n2", kind: "issue", title: "Issue", body: "compile fail" },
			],
			candidateEdges: [{ id: "e1", sourceNodeId: "n1", relation: "fixed_by", targetNodeId: "n2" }],
			budget: { nodeLimit: 10, edgeLimit: 18 },
		});
		expect(body).toEqual({
			task: "query_rerank",
			query: "compile errors",
			candidateNodes: [
				{ id: "n1", kind: "goal", title: "Goal", body: "Build graph" },
				{ id: "n2", kind: "issue", title: "Issue", body: "compile fail" },
			],
			candidateEdges: [{ id: "e1", sourceNodeId: "n1", relation: "fixed_by", targetNodeId: "n2" }],
			budget: { nodeLimit: 10, edgeLimit: 18 },
		});
	});
});

describe("buildRerankHttpHeaders", () => {
	test("uses Bearer auth with the supplied API key by default", () => {
		const headers = buildRerankHttpHeaders({ apiKey: "secret-token" });
		expect(headers.get("authorization")).toBe("Bearer secret-token");
		expect(headers.get("content-type")).toBe("application/json");
	});

	test("uses a custom auth header name when provided", () => {
		const headers = buildRerankHttpHeaders({ apiKey: "raw", headerName: "X-API-Key" });
		expect(headers.get("x-api-key")).toBe("raw");
		expect(headers.get("authorization")).toBeNull();
	});

	test("omits auth header when no API key is supplied", () => {
		const headers = buildRerankHttpHeaders({ apiKey: "" });
		expect(headers.get("authorization")).toBeNull();
	});
});

describe("parseRerankHttpResponse", () => {
	test("accepts a valid RerankPatch", () => {
		expect(parseRerankHttpResponse({ keepNodeIds: ["a"], keepEdgeIds: ["e1"], demoteNodeIds: [] })).toEqual({
			keepNodeIds: ["a"],
			keepEdgeIds: ["e1"],
			demoteNodeIds: [],
		});
	});

	test("rejects unknown keys", () => {
		expect(parseRerankHttpResponse({ keepNodeIds: ["a"], keepEdgeIds: [], demoteNodeIds: [], extra: true })).toBeUndefined();
	});

	test("rejects non-string id arrays", () => {
		expect(parseRerankHttpResponse({ keepNodeIds: [1], keepEdgeIds: [], demoteNodeIds: [] })).toBeUndefined();
	});

	test("rejects non-object bodies", () => {
		expect(parseRerankHttpResponse("not json")).toBeUndefined();
		expect(parseRerankHttpResponse(null)).toBeUndefined();
	});
});

describe("rerankTopologyWithHttp", () => {
	let baseUrl = "http://127.0.0.1:8123";
	let endpointPath = "/v1/topology/rerank";
	let captured: { url: string; body: unknown; headers: Headers; signal: AbortSignal | null } | null = null;

	beforeEach(() => {
		baseUrl = "http://127.0.0.1:8123";
		endpointPath = "/v1/topology/rerank";
		captured = null;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function installFetch(handler: (input: Request | string, init?: RequestInit) => Response | Promise<Response>): void {
		(globalThis as { fetch: typeof fetch }).fetch = (async (input: Request | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.url;
			const headers = new Headers(init?.headers ?? {});
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			captured = { url, body, headers, signal: init?.signal ?? null };
			return await handler(input, init);
		}) as typeof fetch;
	}

	const minimalRequest = {
		task: "query_rerank" as const,
		query: "q",
		candidateNodes: [] as Array<{ id: string; kind: string; title: string; body: string }>,
		candidateEdges: [] as Array<{ id: string; sourceNodeId: string; relation: string; targetNodeId: string }>,
		budget: { nodeLimit: 0, edgeLimit: 0 },
	};

	test("POSTs to baseUrl+endpointPath with auth header and returns the parsed patch", async () => {
		installFetch(() => jsonResponse({ keepNodeIds: ["a"], keepEdgeIds: ["e1"], demoteNodeIds: ["b"], reason: "ok" }));
		const result = await rerankTopologyWithHttp({
			baseUrl,
			endpointPath,
			apiKey: "tok",
			timeoutMs: 1000,
			request: {
				...minimalRequest,
				candidateNodes: [{ id: "a", kind: "goal", title: "A", body: "a" }],
				candidateEdges: [{ id: "e1", sourceNodeId: "a", relation: "r", targetNodeId: "a" }],
				budget: { nodeLimit: 10, edgeLimit: 18 },
			},
		});
		expect(result).toEqual({ keepNodeIds: ["a"], keepEdgeIds: ["e1"], demoteNodeIds: ["b"], reason: "ok" });
		expect(captured?.url).toBe("http://127.0.0.1:8123/v1/topology/rerank");
		expect(captured?.headers.get("authorization")).toBe("Bearer tok");
	});

	test("returns undefined on 5xx without throwing", async () => {
		installFetch(() => jsonResponse({ error: "boom" }, 500));
		const result = await rerankTopologyWithHttp({
			baseUrl,
			endpointPath,
			apiKey: "tok",
			timeoutMs: 1000,
			request: minimalRequest,
		});
		expect(result).toBeUndefined();
	});

	test("returns undefined on invalid response shape", async () => {
		installFetch(() => jsonResponse({ keepNodeIds: "not-array", keepEdgeIds: [], demoteNodeIds: [] }));
		const result = await rerankTopologyWithHttp({
			baseUrl,
			endpointPath,
			apiKey: "tok",
			timeoutMs: 1000,
			request: minimalRequest,
		});
		expect(result).toBeUndefined();
	});

	test("returns undefined when the client-supplied signal is already aborted", async () => {
		// Mock fetch that respects the abort signal it receives, so the client
		// observes a deterministic abort path without a real wall-clock timer.
		installFetch((_input, init) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				return Promise.reject(new DOMException("aborted", "AbortError"));
			}
			if (signal) {
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				});
			}
			return new Promise<Response>(() => {});
		});
		const controller = new AbortController();
		(globalThis as { fetch: typeof fetch }).fetch = (async (input: Request | string, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.url;
			const headers = new Headers(init?.headers ?? {});
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			captured = { url, body, headers, signal: controller.signal };
			return await new Promise<Response>((_resolve, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		}) as typeof fetch;
		const pending = rerankTopologyWithHttp({
			baseUrl,
			endpointPath,
			apiKey: "tok",
			timeoutMs: 1000,
			request: minimalRequest,
		});
		controller.abort();
		const result = await pending;
		expect(result).toBeUndefined();
	});

	test("returns undefined when baseUrl is missing", async () => {
		const result = await rerankTopologyWithHttp({
			baseUrl: "",
			endpointPath,
			apiKey: "tok",
			timeoutMs: 1000,
			request: minimalRequest,
		});
		expect(result).toBeUndefined();
	});
});
