import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cosineSimilarity, embedTexts } from "./topology-siliconflow-embedding.ts";

const originalFetch = globalThis.fetch;

describe("cosineSimilarity", () => {
	test("returns 1 for identical vectors", () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
	});

	test("returns 0 for orthogonal vectors", () => {
		expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
	});

	test("returns -1 for opposite vectors", () => {
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
	});

	test("returns 0 for zero-length vectors", () => {
		expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
	});

	test("returns 0 for mismatched lengths", () => {
		expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
	});

	test("returns 0 for empty arrays", () => {
		expect(cosineSimilarity([], [])).toBe(0);
	});
});

describe("embedTexts", () => {
	let captured: { url: string; body: unknown; headers: Headers } | null = null;

	beforeEach(() => {
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
			captured = { url, body, headers };
			return await handler(input, init);
		}) as typeof fetch;
	}

	test("POSTs to baseUrl + endpointPath with correct model and ordered embeddings", async () => {
		installFetch(() => new Response(JSON.stringify({
			id: "emb-1",
			object: "list",
			data: [
				{ object: "embedding", embedding: [0.3, 0.4], index: 1 },
				{ object: "embedding", embedding: [0.1, 0.2], index: 0 },
			],
			usage: { prompt_tokens: 10, total_tokens: 10 },
		}), { headers: { "content-type": "application/json" } }));

		const result = await embedTexts(
			{ baseUrl: "https://api.example.com/v1", endpointPath: "/embeddings", apiKey: "tok", model: "test-model", timeoutMs: 5000 },
			["hello", "world"],
		);
		expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
		expect(captured?.url).toBe("https://api.example.com/v1/embeddings");
		expect((captured?.body as Record<string, unknown>)?.model).toBe("test-model");
		expect((captured?.body as Record<string, unknown>)?.input).toEqual(["hello", "world"]);
		expect(captured?.headers.get("authorization")).toBe("Bearer tok");
	});

	test("uses default endpointPath /embeddings when empty", async () => {
		installFetch(() => new Response(JSON.stringify({
			id: "emb-2", object: "list",
			data: [{ object: "embedding", embedding: [1], index: 0 }],
			usage: { prompt_tokens: 1, total_tokens: 1 },
		}), { headers: { "content-type": "application/json" } }));

		await embedTexts({ baseUrl: "https://api.example.com/v1", endpointPath: "", apiKey: "k", model: "m", timeoutMs: 1000 }, ["x"]);
		expect(captured?.url).toBe("https://api.example.com/v1/embeddings");
	});

	test("returns undefined on 5xx", async () => {
		installFetch(() => new Response("error", { status: 500 }));
		const result = await embedTexts({ baseUrl: "https://api.example.com/v1", endpointPath: "/embeddings", apiKey: "k", model: "m", timeoutMs: 1000 }, ["x"]);
		expect(result).toBeUndefined();
	});

	test("returns undefined on empty input", async () => {
		const result = await embedTexts({ baseUrl: "https://api.example.com/v1", endpointPath: "/embeddings", apiKey: "k", model: "m", timeoutMs: 1000 }, []);
		expect(result).toBeUndefined();
	});

	test("returns undefined on missing baseUrl", async () => {
		const result = await embedTexts({ baseUrl: "", endpointPath: "/embeddings", apiKey: "k", model: "m", timeoutMs: 1000 }, ["x"]);
		expect(result).toBeUndefined();
	});
});
