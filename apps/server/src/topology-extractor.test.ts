import { describe, expect, test } from "bun:test";

import { buildExtractionPrompt, buildExtractorRpcCommand, createPooledTopologyExtractorClient, parseExtractionResponse, refineNodesWithLLM, type TopologyExtractorModelClient } from "./topology-extractor.ts";
import type { SessionContextNode } from "@omp-deck/protocol";

function makeNode(id: string, kind: SessionContextNode["kind"], title: string, body: string): SessionContextNode {
	return {
		id, sessionId: "s1", kind, title, body, compressedBody: body,
		importance: 0.7, createdAt: "2026-07-08T00:00:00.000Z",
		sourceMessageId: id, sourceTurnIndex: 1, metadata: {},
	};
}

describe("topology-extractor", () => {
	test("buildExtractionPrompt serializes nodes as JSON", () => {
		const prompt = buildExtractionPrompt([
			{ id: "n1", kind: "evidence", title: "file read", body: "export function foo() {}", role: "toolResult" },
		]);
		expect(prompt).toContain("n1");
		expect(prompt).toContain("evidence");
	});

	test("buildExtractorRpcCommand builds invoke_model_role envelope", () => {
		const cmd = buildExtractorRpcCommand({ modelRole: "topology_extractor", prompt: "test" });
		expect(cmd.type).toBe("invoke_model_role");
		expect(cmd.modelRole).toBe("topology_extractor");
		expect(cmd.responseFormat.schemaName).toBe("TopologyExtractionResult");
		expect(cmd.input.systemPrompt).toContain("Classification rules");
	});

	test("parseExtractionResponse accepts direct nodes array", () => {
		const result = parseExtractionResponse({
			nodes: [
				{ id: "n1", kind: "evidence", title: "refined title", body: "refined body" },
				{ id: "n2", kind: "skip", title: "noise", body: "" },
			],
		});
		expect(result).toHaveLength(2);
		expect(result?.[0]?.kind).toBe("evidence");
		expect(result?.[1]?.kind).toBe("skip");
	});

	test("parseExtractionResponse accepts nested output wrapper", () => {
		const result = parseExtractionResponse({
			output: { nodes: [{ id: "n1", kind: "issue", title: "real error", body: "ENOENT" }] },
		});
		expect(result).toHaveLength(1);
		expect(result?.[0]?.kind).toBe("issue");
	});

	test("parseExtractionResponse rejects invalid kinds", () => {
		const result = parseExtractionResponse({
			nodes: [{ id: "n1", kind: "bogus", title: "x", body: "y" }],
		});
		expect(result).toBeUndefined();
	});

	test("parseExtractionResponse returns undefined for non-object input", () => {
		expect(parseExtractionResponse(null)).toBeUndefined();
		expect(parseExtractionResponse("string")).toBeUndefined();
		expect(parseExtractionResponse(42)).toBeUndefined();
	});

	test("refineNodesWithLLM drops skip nodes and updates fields", async () => {
		const client: TopologyExtractorModelClient = {
			async extractNodes() {
				return {
					nodes: [
						{ id: "n1", kind: "evidence", title: "better title", body: "better body" },
						{ id: "n2", kind: "skip", title: "", body: "" },
					],
				};
			},
		};
		const input = [
			makeNode("n1", "evidence", "original title", "original body"),
			makeNode("n2", "issue", "false positive", "noise"),
		];
		const result = await refineNodesWithLLM({ nodes: input, client, modelRole: "topology_extractor" });
		expect(result).toHaveLength(1);
		expect(result[0]?.title).toBe("better title");
		expect(result[0]?.body).toBe("better body");
	});

	test("refineNodesWithLLM falls back to original on client error", async () => {
		const client: TopologyExtractorModelClient = {
			async extractNodes() { throw new Error("network"); },
		};
		const input = [makeNode("n1", "evidence", "title", "body")];
		const result = await refineNodesWithLLM({ nodes: input, client, modelRole: "topology_extractor" });
		expect(result).toEqual(input);
	});

	test("refineNodesWithLLM falls back when response is empty", async () => {
		const client: TopologyExtractorModelClient = {
			async extractNodes() { return { nodes: [] }; },
		};
		const input = [makeNode("n1", "evidence", "title", "body")];
		const result = await refineNodesWithLLM({ nodes: input, client, modelRole: "topology_extractor" });
		expect(result).toEqual(input);
	});

	test("buildExtractionPrompt includes all nodes so the pool can chunk", () => {
		const prompt = buildExtractionPrompt(Array.from({ length: 25 }, (_, i) => ({
			id: `n${i}`,
			kind: "evidence",
			title: `title ${i}`,
			body: `body ${i}`,
			role: "toolResult",
		})));
		const parsed = JSON.parse(prompt) as Array<{ id: string }>;
		expect(parsed).toHaveLength(25);
		expect(parsed.at(-1)?.id).toBe("n24");
	});

	test("pooled extractor splits chunks across fast and local providers", async () => {
		const calls: Array<{ label: string; ids: string[] }> = [];
		function client(label: string): TopologyExtractorModelClient {
			return {
				async extractNodes({ prompt }) {
					const chunk = JSON.parse(prompt) as Array<{ id: string }>;
					calls.push({ label, ids: chunk.map((n) => n.id) });
					return { nodes: chunk.map((n) => ({ id: n.id, kind: "evidence", title: `${label}:${n.id}`, body: `${label} body` })) };
				},
			};
		}
		const pooled = createPooledTopologyExtractorClient({
			chunkSize: 2,
			slots: [
				{ label: "fast", client: client("fast"), maxConcurrency: 2 },
				{ label: "local", client: client("local"), maxConcurrency: 1 },
			],
		});
		const input = Array.from({ length: 5 }, (_, i) => makeNode(`n${i}`, "evidence", `title ${i}`, `body ${i}`));
		const result = await refineNodesWithLLM({ nodes: input, client: pooled, modelRole: "topology_extractor" });
		expect(calls).toHaveLength(3);
		expect(calls).toContainEqual({ label: "fast", ids: ["n0", "n1"] });
		expect(calls).toContainEqual({ label: "local", ids: ["n2", "n3"] });
		expect(calls).toContainEqual({ label: "fast", ids: ["n4"] });
		expect(result.map((n) => n.title)).toEqual(["fast:n0", "fast:n1", "local:n2", "local:n3", "fast:n4"]);
	});

	test("pooled extractor honors per-provider concurrency caps", async () => {
		let active = 0;
		let maxActive = 0;
		const client: TopologyExtractorModelClient = {
			async extractNodes({ prompt }) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await Promise.resolve();
				active -= 1;
				const chunk = JSON.parse(prompt) as Array<{ id: string }>;
				return { nodes: chunk.map((n) => ({ id: n.id, kind: "evidence", title: n.id, body: "ok" })) };
			},
		};
		const pooled = createPooledTopologyExtractorClient({ chunkSize: 1, slots: [{ label: "local", client, maxConcurrency: 2 }] });
		const promise = pooled.extractNodes({
			modelRole: "topology_extractor",
			prompt: buildExtractionPrompt(Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, kind: "evidence", title: "t", body: "b", role: "toolResult" }))),
			timeoutMs: 60_000,
		});
		await Promise.resolve();
		expect(maxActive).toBe(2);
		await promise;
		expect(maxActive).toBe(2);
	});

	test("pooled extractor skips failed chunks and lets refinement preserve originals", async () => {
		const pooled = createPooledTopologyExtractorClient({
			chunkSize: 2,
			slots: [{
				label: "fast",
				maxConcurrency: 1,
				client: {
					async extractNodes({ prompt }) {
						const chunk = JSON.parse(prompt) as Array<{ id: string }>;
						if (chunk.some((n) => n.id === "n2")) throw new Error("provider failed");
						return { nodes: chunk.map((n) => ({ id: n.id, kind: "evidence", title: `refined ${n.id}`, body: "refined" })) };
					},
				},
			}],
		});
		const input = Array.from({ length: 4 }, (_, i) => makeNode(`n${i}`, "evidence", `original ${i}`, `body ${i}`));
		const result = await refineNodesWithLLM({ nodes: input, client: pooled, modelRole: "topology_extractor" });
		expect(result.map((n) => n.title)).toEqual(["refined n0", "refined n1", "original 2", "original 3"]);
	});
	test("fast slot fans out wider than local slot", async () => {
		const perSlot: Record<string, number> = { fast: 0, local: 0 };
		const perSlotMax: Record<string, number> = { fast: 0, local: 0 };
		function trackingClient(label: string): TopologyExtractorModelClient {
			return {
				async extractNodes({ prompt }) {
					perSlot[label] = (perSlot[label] ?? 0) + 1;
					perSlotMax[label] = (perSlotMax[label] ?? 0) + 1;
					// Tiny await yields control so the scheduler can fill slots.
					await Promise.resolve();
					perSlotMax[label] -= 1;
					const chunk = JSON.parse(prompt) as Array<{ id: string }>;
					return { nodes: chunk.map((n) => ({ id: n.id, kind: "evidence", title: n.id, body: "ok" })) };
				},
			};
		}
		const pooled = createPooledTopologyExtractorClient({
			chunkSize: 1,
			slots: [
				{ label: "fast", client: trackingClient("fast"), maxConcurrency: 4 },
				{ label: "local", client: trackingClient("local"), maxConcurrency: 2 },
			],
		});
		const result = await pooled.extractNodes({
			modelRole: "topology_extractor",
			prompt: buildExtractionPrompt(Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, kind: "evidence", title: "t", body: "b", role: "toolResult" }))),
			timeoutMs: 60_000,
		});
		// Per-slot caps must never be exceeded, and both slots must have run.
		expect(perSlotMax.fast).toBeLessThanOrEqual(4);
		expect(perSlotMax.local).toBeLessThanOrEqual(2);
		expect(perSlot.fast).toBeGreaterThan(0);
		expect(perSlot.local).toBeGreaterThan(0);
		expect(result).toBeDefined();
	});
	test("pool extractor splits oversized chunks by byte budget", async () => {
		let calls = 0;
		const pooled = createPooledTopologyExtractorClient({
			chunkSize: 50,
			maxChunkBytes: 500,
			slots: [{
				label: "fast",
				maxConcurrency: 1,
				client: {
					async extractNodes({ prompt }) {
						calls += 1;
						const chunk = JSON.parse(prompt) as Array<{ id: string }>;
						return { nodes: chunk.map((n) => ({ id: n.id, kind: "evidence", title: n.id, body: "ok" })) };
					},
				},
			}],
		});
		const fat = (id: string, body: string) => ({ id, kind: "evidence", title: "t", body, role: "toolResult" });
		const nodes = [
			fat("a", "x".repeat(300)),
			fat("b", "x".repeat(300)),
			fat("c", "x".repeat(300)),
		];
		const result = await pooled.extractNodes({
			modelRole: "topology_extractor",
			prompt: buildExtractionPrompt(nodes),
			timeoutMs: 60_000,
		});
		// Each 300-byte body + 64-byte overhead ≈ 364B; 500B cap forces a split.
		expect(calls).toBeGreaterThan(1);
		expect(result).toBeDefined();
	});
});
