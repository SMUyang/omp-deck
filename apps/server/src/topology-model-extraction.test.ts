import { describe, expect, test } from "bun:test";

import { extractWithFastModel, getModelExtractionConfig, type ModelExtractionConfig } from "./topology-model-extraction.ts";

describe("getModelExtractionConfig", () => {
	test("returns defaults when env is empty", () => {
		const config = getModelExtractionConfig({});
		expect(config.enabled).toBe(false);
		expect(config.batchSize).toBe(15);
		expect(config.timeoutMs).toBe(30_000);
	});

	test("reads config from env object", () => {
		const config = getModelExtractionConfig({
			OMP_DECK_TOPOLOGY_EXTRACTION_MODE: "fast_model",
			OMP_DECK_TOPOLOGY_EXTRACTION_MODEL: "test-model",
			OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE: "20",
		});
		expect(config.enabled).toBe(true);
		expect(config.model).toBe("test-model");
		expect(config.batchSize).toBe(20);
	});
});

describe("extractWithFastModel", () => {
	const config: ModelExtractionConfig = {
		enabled: true,
		model: "test-model",
		baseUrl: "http://127.0.0.1:9999",
		endpointPath: "/v1/chat/completions",
		apiKey: "test-key",
		batchSize: 15,
		timeoutMs: 5000,
	};

	let originalFetch: typeof globalThis.fetch;

	function installFetch(handler: (input: Request | string, init?: RequestInit) => Response | Promise<Response>): void {
		originalFetch = globalThis.fetch;
		(globalThis as { fetch: typeof fetch }).fetch = (async (input: Request | string, init?: RequestInit) => {
			return await handler(input, init);
		}) as typeof fetch;
	}

	test("returns empty nodes when baseUrl is empty", async () => {
		const result = await extractWithFastModel({ ...config, baseUrl: "" }, []);
		expect(result.nodes).toEqual([]);
	});

	test("returns empty nodes when messages is empty", async () => {
		const result = await extractWithFastModel(config, []);
		expect(result.nodes).toEqual([]);
	});

	test("sends batch to model and parses extraction result", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({ nodes: [
							{ kind: "goal", title: "Build graph memory", compressedBody: "Build graph memory for sessions", importance: 0.7, inputIndex: 0 },
							{ kind: "decision", title: "Use SQLite for storage", compressedBody: "SQLite chosen for simplicity", importance: 0.9, inputIndex: 1 },
						]}),
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [
			{ id: "u1", role: "user", text: "I want to build graph memory", turnIndex: 1, createdAt: "2026-07-02T00:00:01.000Z" },
			{ id: "a1", role: "assistant", text: "I recommend using SQLite for storage", turnIndex: 2, createdAt: "2026-07-02T00:00:02.000Z" },
		];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes.length).toBe(2);
		expect(result.nodes[0]!.kind).toBe("goal");
		expect(result.nodes[0]!.messageId).toBe("u1");
		expect(result.nodes[1]!.kind).toBe("decision");
		expect(result.nodes[1]!.messageId).toBe("a1");
	});

	test("filters out filler messages from extraction", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({ nodes: [
							{ kind: "goal", title: "Build graph memory", compressedBody: "Build graph memory", importance: 0.7, inputIndex: 0 },
						]}),
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [
			{ id: "u1", role: "user", text: "I want to build graph memory", turnIndex: 1, createdAt: "2026-07-02T00:00:01.000Z" },
			{ id: "a1", role: "assistant", text: "ok", turnIndex: 2, createdAt: "2026-07-02T00:00:02.000Z" },
		];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes.length).toBe(1);
		expect(result.nodes[0]!.kind).toBe("goal");
	});


	test("maps by inputIndex when model skips filler message at index 0", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({ nodes: [
							{ kind: "decision", title: "Use SQLite", compressedBody: "SQLite chosen", importance: 0.9, inputIndex: 1 },
						]}),
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [
			{ id: "u1", role: "user", text: "ok", turnIndex: 1, createdAt: "2026-07-02T00:00:01.000Z" },
			{ id: "a1", role: "assistant", text: "I recommend using SQLite for storage", turnIndex: 2, createdAt: "2026-07-02T00:00:02.000Z" },
		];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes.length).toBe(1);
		expect(result.nodes[0]!.kind).toBe("decision");
		expect(result.nodes[0]!.messageId).toBe("a1");
		expect(result.nodes[0]!.turnIndex).toBe(2);
		expect(result.nodes[0]!.createdAt).toBe("2026-07-02T00:00:02.000Z");
	});

	test("uses reasoning_content when content is empty", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: "",
						reasoning_content: JSON.stringify({ nodes: [
							{ kind: "goal", title: "Build graph memory", compressedBody: "Build graph memory", importance: 0.7, inputIndex: 0 },
						]}),
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [{ id: "u1", role: "user", text: "message 1", turnIndex: 0, createdAt: "2026-07-02T00:00:01.000Z" }];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes.length).toBe(1);
		expect(result.nodes[0]!.kind).toBe("goal");
	});

	test("returns empty when neither content nor reasoning_content has valid JSON", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: "",
						reasoning_content: "just some thinking, no json here",
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [{ id: "u1", role: "user", text: "message 1", turnIndex: 0, createdAt: "2026-07-02T00:00:01.000Z" }];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes).toEqual([]);
	});

	test("returns empty on invalid JSON response", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: "not valid json",
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [
			{ id: "u1", role: "user", text: "test", turnIndex: 1, createdAt: "2026-07-02T00:00:01.000Z" },
		];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes).toEqual([]);
	});

	test("returns empty on HTTP error", async () => {
		installFetch(() => new Response("error", { status: 500 }));
		const messages = [
			{ id: "u1", role: "user", text: "test", turnIndex: 1, createdAt: "2026-07-02T00:00:01.000Z" },
		];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes).toEqual([]);
	});

	test("truncates title and compressedBody to limits", async () => {
		installFetch(() => {
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: JSON.stringify({ nodes: [
							{ kind: "goal", title: "A".repeat(200), compressedBody: "B".repeat(600), importance: 0.7, inputIndex: 0 },
						]}),
					},
				}],
			}), { headers: { "content-type": "application/json" } });
		});

		const messages = [
			{ id: "u1", role: "user", text: "test", turnIndex: 1, createdAt: "2026-07-02T00:00:01.000Z" },
		];
		const result = await extractWithFastModel(config, messages);
		expect(result.nodes.length).toBe(1);
		expect(result.nodes[0]!.title.length).toBeLessThanOrEqual(120);
		expect(result.nodes[0]!.compressedBody.length).toBeLessThanOrEqual(500);
	});
});
