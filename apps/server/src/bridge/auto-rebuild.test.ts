import { describe, expect, test } from "bun:test";

import { AutoRebuildTopology, createExtractorPool, type AutoRebuildCheckpoint, type AutoRebuildDeps } from "./auto-rebuild.ts";
import { buildExtractionPrompt } from "../topology-extractor.ts";

/** Build stub deps with controllable behaviour for deterministic async tests. */
function makeDeps(overrides: Partial<AutoRebuildDeps> = {}): AutoRebuildDeps {
	return {
		sessionId: "test-session",
		getSessionFile: () => "/fake/session.jsonl",
		statFile: () => Promise.resolve({ mtimeMs: 1000, size: 500 }),
		getCheckpoint: () => ({ built: false }),
		rebuild: () => Promise.resolve(),
		sleep: () => Promise.resolve(),
		...overrides,
	};
}

function checkpoint(extractionSchemaVersion?: number, overrides: Partial<AutoRebuildCheckpoint> = {}) {
	return {
		built: true,
		sourcePath: "/fake/session.jsonl",
		sourceMtimeMs: 1000,
		sourceSizeBytes: 500,
		...(extractionSchemaVersion === undefined ? {} : { extractionSchemaVersion }),
		...overrides,
	};
}

/** Tiny deferred for deterministic async test control. */
function defer<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe("AutoRebuildTopology", () => {
	test("rebuilds when checkpoint is stale", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(1);
	});

	test("rebuilds when matching source checkpoint uses extraction schema version 1", async () => {
		let rebuilt = 0;
		const sleeps: number[] = [];
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => checkpoint(1),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
			sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(1);
		expect(sleeps).toEqual([500]);
	});

	test("skips rebuild when matching source checkpoint uses current extraction schema version", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => checkpoint(2),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("treats a legacy checkpoint without extraction schema version as version 1 and stale", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => checkpoint(),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(1);
	});

	test("keeps a matching checkpoint from a newer extraction schema version fresh", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => checkpoint(3),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("rebuilds on source mtime or size mismatch regardless of extraction schema version", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => checkpoint(3, { sourceMtimeMs: 999, sourceSizeBytes: 499 }),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(1);
	});

	test("rebuilds when normalized checkpoint source path differs", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getCheckpoint: () => checkpoint(2, { sourcePath: "/fake/other.jsonl" }),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(1);
	});


	test("skips when sessionFile is undefined", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			getSessionFile: () => undefined,
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("skips when stat throws (file not ready)", async () => {
		let rebuilt = 0;
		const arb = new AutoRebuildTopology(makeDeps({
			statFile: () => Promise.reject(new Error("ENOENT")),
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));
		await arb.trigger();
		expect(rebuilt).toBe(0);
	});

	test("single-flight: reentrant trigger during rebuild causes exactly one catch-up", async () => {
		let rebuilt = 0;
		const firstRebuild = defer<void>();
		const rebuildEntered = defer<void>();

		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => {
				rebuilt++;
				if (rebuilt === 1) {
					rebuildEntered.resolve();
					return firstRebuild.promise;
				}
				return Promise.resolve();
			},
		}));

		const firstPromise = arb.trigger();
		await rebuildEntered.promise; // first run has entered rebuild()
		arb.trigger();                  // reentrant — should set pending, not start a second rebuild
		expect(rebuilt).toBe(1);
		firstRebuild.resolve();         // release first rebuild — catch-up fires
		await firstPromise;
		expect(rebuilt).toBe(2);
	});

	test("honors pending trigger after stat failure", async () => {
		let rebuilt = 0;
		let statCall = 0;
		const firstStat = defer<{ mtimeMs: number; size: number }>();

		const arb = new AutoRebuildTopology(makeDeps({
			statFile: () => {
				statCall++;
				return statCall === 1 ? firstStat.promise : Promise.resolve({ mtimeMs: 2000, size: 600 });
			},
			rebuild: () => { rebuilt++; return Promise.resolve(); },
		}));

		const p1 = arb.trigger();
		arb.trigger();                  // reentrant while first stat is deferred
		firstStat.reject(new Error("ENOENT")); // release stat as failure
		await p1;

		expect(statCall).toBe(2);
		expect(rebuilt).toBe(1);
	});

	test("swallows rebuild errors without rejection", async () => {
		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => Promise.reject(new Error("DB locked")),
		}));
		await arb.trigger();
	});

	test("maybeTrigger is fire-and-forget (returns void)", async () => {
		const rebuildEntered = defer<void>();
		const arb = new AutoRebuildTopology(makeDeps({
			rebuild: () => { rebuildEntered.resolve(); return Promise.resolve(); },
		}));
		const result = arb.maybeTrigger();
		expect(result).toBeUndefined();
		await rebuildEntered.promise;
	});
});

describe("createExtractorPool", () => {
	test("honors OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE for chunking", async () => {
		const origFetch = globalThis.fetch;
		const origApiKey = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY;
		const origBatchSize = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE;
		const origModel = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL;
		try {
			process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE = "fast_model";
			process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY = "test-key";
			process.env.OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE = "5";

			const fetchCalls: Array<{ chunkNodeCount: number }> = [];
			globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const bodyStr = typeof init?.body === "string" ? init.body : "";
				// createHttpExtractor always builds a standard OpenAI chat completions body
				const bodyObj = JSON.parse(bodyStr) as { messages: Array<{ role: string; content: string }> };
				const userMsg = bodyObj.messages.find((m) => m.role === "user");
				if (!userMsg) throw new Error("no user message in mock fetch");
				const chunkNodes = JSON.parse(userMsg.content) as Array<{ id: string }>;
				fetchCalls.push({ chunkNodeCount: chunkNodes.length });
				return Promise.resolve(Response.json({
					choices: [{
						message: {
							content: JSON.stringify({
								nodes: chunkNodes.map((n) => ({ id: n.id, operationDetail: "refine_test_node", refinedPurpose: `Refine ${n.id}` })),
							}),
						},
					}],
				}));
			}) as unknown as typeof globalThis.fetch; // test-only monkey-patch, restored in finally

			const pool = createExtractorPool();
			expect(pool).not.toBeNull();

			const inputNodes = Array.from({ length: 20 }, (_, i) => ({
				id: `n${i}`,
				kind: "evidence",
				title: `title ${i}`,
				body: `body ${i}`,
				role: "toolResult",
			}));
			const result = await pool!.extractNodes({
				modelRole: "topology_extractor",
				prompt: buildExtractionPrompt(inputNodes),
				timeoutMs: 60_000,
			});

			// 20 nodes / 5 per chunk = 4 chunks.
			// Regression guard: chunking must follow the BATCH_SIZE env value, not a hard-coded default.
			expect(fetchCalls.length).toBe(4);
			for (const call of fetchCalls) {
				expect(call.chunkNodeCount).toBeLessThanOrEqual(5);
			}
			if (!result || typeof result !== "object" || !("nodes" in result)) {
				throw new Error("expected { nodes: [...] } from extractor pool");
			}
			expect(Array.isArray(result.nodes)).toBe(true);
			if (Array.isArray(result.nodes)) {
				expect(result.nodes.length).toBe(20);
			}
		} finally {
			globalThis.fetch = origFetch;
			if (origApiKey === undefined) delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY;
			else process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY = origApiKey;
			if (origBatchSize === undefined) delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE;
			else process.env.OMP_DECK_TOPOLOGY_EXTRACTION_BATCH_SIZE = origBatchSize;
			if (origModel === undefined) delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL;
			else process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL = origModel;
		}
	});

	test("sends max_tokens from OMP_DECK_TOPOLOGY_EXTRACTION_MAX_TOKENS in request body", async () => {
		const origFetch = globalThis.fetch;
		const origApiKey = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY;
		const origMaxTokens = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MAX_TOKENS;
		const origModel = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL;
		try {
			process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE = "fast_model";
			process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY = "test-key";
			process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MAX_TOKENS = "1234";

			let requestBody: Record<string, unknown> | null = null;
			globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const bodyStr = typeof init?.body === "string" ? init.body : "";
				requestBody = JSON.parse(bodyStr) as Record<string, unknown>;
				return Promise.resolve(Response.json({
					choices: [{ message: { content: JSON.stringify({ nodes: [{ id: "n0", kind: "evidence", title: "t", body: "b" }] }) } }],
				}));
			}) as unknown as typeof globalThis.fetch;

			const pool = createExtractorPool();
			expect(pool).not.toBeNull();

			await pool!.extractNodes({
				modelRole: "topology_extractor",
				prompt: buildExtractionPrompt([{ id: "n0", kind: "evidence", title: "t", body: "b", role: "toolResult" }]),
				timeoutMs: 60_000,
			});

			expect(requestBody).not.toBeNull();
			expect(requestBody!.max_tokens).toBe(1234);
			expect(requestBody!.model).toBe("deepseek-v4-flash");
		} finally {
			globalThis.fetch = origFetch;
			if (origApiKey === undefined) delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY;
			else process.env.OMP_DECK_TOPOLOGY_EXTRACTION_API_KEY = origApiKey;
			if (origMaxTokens === undefined) delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MAX_TOKENS;
			else process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MAX_TOKENS = origMaxTokens;
			if (origModel === undefined) delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL;
			else process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODEL = origModel;
		}
	});
});
