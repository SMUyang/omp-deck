import { describe, expect, test } from "bun:test";

import type { SessionContextNode } from "@omp-deck/protocol";
import { buildExtractionPrompt, buildExtractorRpcCommand, createPooledTopologyExtractorClient, parseExtractionResponse, refineNodesWithLLM, type TopologyExtractorModelClient } from "./topology-extractor.ts";

function makeNode(id: string): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind: "action",
		title: "Deterministic title",
		body: "Deterministic body",
		compressedBody: "Deterministic body",
		importance: 0.9,
		createdAt: "2026-07-31T10:00:00.000Z",
		sourceMessageId: "a1",
		sourceTurnIndex: 3,
		population: "assistant",
		nodeRole: "main",
		origin: "assistant",
		pairId: "s1:pair:u1",
		operation: "answer",
		purpose: "Answer the explicit question",
		purposeSource: "explicit_text",
		status: "completed",
		metadata: { sourceEntryId: "a1" },
	};
}

function clientWith(raw: unknown): TopologyExtractorModelClient {
	return { async extractNodes() { return raw; } };
}

describe("topology-extractor refinement contract", () => {
	test("buildExtractionPrompt exposes deterministic context but asks only for optional operation detail and refined purpose", () => {
		const prompt = buildExtractionPrompt([{ id: "n1", operation: "answer", purpose: "Explain storage", body: "It stores nodes." }]);
		expect(prompt).toContain("n1");
		expect(prompt).toContain("operation");
		expect(prompt).toContain("purpose");
	});

	test("buildExtractorRpcCommand uses the conversation purpose refinement prompt contract", () => {
		const cmd = buildExtractorRpcCommand({ modelRole: "topology_extractor", prompt: "test" });
		expect(cmd.type).toBe("invoke_model_role");
		expect(cmd.responseFormat.schemaName).toBe("TopologyExtractionResult");
		expect(cmd.input.systemPrompt).toContain("operationDetail");
		expect(cmd.input.systemPrompt).toContain("refinedPurpose");
		expect(cmd.input.systemPrompt).toContain("must not change");
	});

	test("parseExtractionResponse accepts only id operationDetail and refinedPurpose", () => {
		expect(parseExtractionResponse({ nodes: [{ id: "n1", operationDetail: "explain_storage", refinedPurpose: "Explain how topology storage works" }] })).toEqual([
			{ id: "n1", operationDetail: "explain_storage", refinedPurpose: "Explain how topology storage works" },
		]);
	});

	test("parseExtractionResponse rejects malformed or structurally mutating entries", () => {
		expect(parseExtractionResponse(null)).toBeUndefined();
		expect(parseExtractionResponse({ nodes: [{ id: "n1", kind: "resolution", refinedPurpose: "changed" }] })).toBeUndefined();
		expect(parseExtractionResponse({ nodes: [{ id: "n1", operationDetail: 7 }] })).toBeUndefined();
		expect(parseExtractionResponse({ nodes: [{ id: "n1" }] })).toBeUndefined();
	});

	test("refineNodesWithLLM applies bounded redacted optional fields and records provenance only when accepted", async () => {
		const secret = `sk-proj-${"A".repeat(30)}`;
		const input = [makeNode("n1")];
		const result = await refineNodesWithLLM({
			nodes: input,
			client: clientWith({ nodes: [{ id: "n1", operationDetail: "x".repeat(200), refinedPurpose: `Explain ${secret} ${"z".repeat(500)}` }] }),
			modelRole: "topology_extractor",
		});
		expect(result[0]?.operationDetail?.length).toBeLessThanOrEqual(120);
		expect(result[0]?.refinedPurpose?.length).toBeLessThanOrEqual(240);
		expect(result[0]?.refinedPurpose).toContain("[REDACTED]");
		expect(result[0]?.refinement).toEqual({ model: "topology_extractor", promptVersion: "conversation-purpose-v1" });
	});

	test("refiner cannot mutate deterministic structure source status text or metadata", async () => {
		const input = [makeNode("n1")];
		const raw = { nodes: [{
			id: "n1",
			operationDetail: "answer_storage",
			refinedPurpose: "Clarify storage",
			kind: "resolution",
			title: "Changed",
			body: "Changed",
			population: "user",
			nodeRole: "child",
			origin: "tool",
			childType: "error",
			pairId: "evil",
			parentNodeId: "evil",
			operation: "modify",
			purpose: "evil",
			purposeSource: "deterministic",
			status: "failed",
			sourceMessageId: "evil",
			sourceTurnIndex: 99,
			createdAt: "evil",
			metadata: { evil: true },
		}] };
		const result = await refineNodesWithLLM({ nodes: input, client: clientWith(raw), modelRole: "topology_extractor" });
		expect(result).toEqual(input);
	});

	test("unknown IDs invalid values and malformed responses leave deterministic nodes unchanged", async () => {
		const input = [makeNode("n1")];
		for (const raw of [
			{ nodes: [{ id: "unknown", operationDetail: "detail" }] },
			{ nodes: [{ id: "n1", operationDetail: "Not snake case!" }] },
			{ nodes: [{ id: "n1", refinedPurpose: "" }] },
			"not-json",
		]) {
			expect(await refineNodesWithLLM({ nodes: input, client: clientWith(raw), modelRole: "topology_extractor" })).toEqual(input);
		}
	});

	test("client failure preserves original object list without provenance", async () => {
		const input = [makeNode("n1")];
		const client: TopologyExtractorModelClient = { async extractNodes() { throw new Error("timeout"); } };
		expect(await refineNodesWithLLM({ nodes: input, client, modelRole: "topology_extractor" })).toEqual(input);
	});
});

describe("topology-extractor pool", () => {
	test("pooled extractor splits chunks across configured slots", async () => {
		const calls: Array<{ label: string; ids: string[] }> = [];
		function client(label: string): TopologyExtractorModelClient {
			return {
				async extractNodes({ prompt }) {
					const chunk = JSON.parse(prompt) as Array<{ id: string }>;
					calls.push({ label, ids: chunk.map((node) => node.id) });
					return { nodes: chunk.map((node) => ({ id: node.id, operationDetail: `${label}_detail` })) };
				},
			};
		}
		const pooled = createPooledTopologyExtractorClient({ chunkSize: 2, slots: [
			{ label: "fast", client: client("fast"), maxConcurrency: 2 },
			{ label: "local", client: client("local"), maxConcurrency: 1 },
		] });
		const input = Array.from({ length: 5 }, (_, index) => makeNode(`n${index}`));
		const result = await refineNodesWithLLM({ nodes: input, client: pooled, modelRole: "topology_extractor" });
		expect(calls).toHaveLength(3);
		expect(result.map((node) => node.operationDetail)).toEqual(["fast_detail", "fast_detail", "local_detail", "local_detail", "fast_detail"]);
	});

	test("pooled extractor preserves originals for failed chunks", async () => {
		const pooled = createPooledTopologyExtractorClient({ chunkSize: 2, slots: [{ label: "fast", maxConcurrency: 1, client: {
			async extractNodes({ prompt }) {
				const chunk = JSON.parse(prompt) as Array<{ id: string }>;
				if (chunk.some((node) => node.id === "n2")) throw new Error("provider failed");
				return { nodes: chunk.map((node) => ({ id: node.id, operationDetail: "accepted_detail" })) };
			},
		} }] });
		const input = Array.from({ length: 4 }, (_, index) => makeNode(`n${index}`));
		const result = await refineNodesWithLLM({ nodes: input, client: pooled, modelRole: "topology_extractor" });
		expect(result.map((node) => node.operationDetail)).toEqual(["accepted_detail", "accepted_detail", undefined, undefined]);
	});
});
