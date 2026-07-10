import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import { getSessionContextGraph, getNodeEmbeddings, saveNodeEmbeddings } from "./db/session-context.ts";
import { extractSessionContextFromJsonl, getStoredQueryTopologyFocus, rebuildSessionContextFromFile, renderPackAsCompactFocus, renderRetrievedTopologyAsFocus, renderSessionContextPack, renderTopologyGraphAsCompactFocus, retrieveTopologyWithEmbeddings, shouldReplaceContext } from "./session-context.ts";
import { retrieveTopology, type RetrievedTopology } from "./session-topology-retrieval.ts";
import type { SessionContextGraphResponse, SessionContextPackResponse } from "@omp-deck/protocol";
import type { EmbeddingConfig } from "./topology-siliconflow-embedding.ts";
import type { TopologyExtractorModelClient } from "./topology-extractor.ts";

const jsonl = [
	JSON.stringify({ type: "title", v: 1, title: "Context topology" }),
	JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
	JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "继续会话内拓扑记忆系统的搭建" }] } }),
	JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "推荐先做 Memory Cockpit 可视化拓扑。" }] } }),
	JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "我希望的是作为上下文数据的替换方法，节省上下文空间" }] } }),
	JSON.stringify({ type: "message", id: "tool1", timestamp: "2026-07-02T00:00:04.000Z", message: { role: "tool", content: [{ type: "text", text: "bun test apps/server/src/session-context.test.ts\n10 pass 0 fail" }] } }),
].join("\n");

describe("session context extraction", () => {
	test("extracts user correction as superseding intent", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: jsonl });

		const correction = result.nodes.find((node) => node.kind === "user_intent" && node.body.includes("上下文数据"));
		expect(correction).toBeDefined();
		expect(result.nodes.some((node) => node.kind === "goal" && node.body.includes("拓扑记忆"))).toBe(true);
		expect(result.edges.some((edge) => edge.relation === "supersedes" || edge.relation === "contradicts")).toBe(true);
	});

	test("extracts test output as evidence", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: jsonl });

		expect(result.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "evidence", sourceMessageId: "tool1" }),
		]));
		expect(result.artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "test", ref: "bun test apps/server/src/session-context.test.ts" }),
		]));
	});

	test("renders compact context pack with correction before stale assumption", () => {
		const extracted = extractSessionContextFromJsonl({ sessionId: "s1", content: jsonl });
		const pack = renderSessionContextPack({ sessionId: "s1", query: "节省上下文空间", budget: 1600, ...extracted });

		expect(pack.summary).toContain("上下文");
		expect(pack.goals.length).toBeGreaterThan(0);
		expect(pack.rawRefs.some((ref) => ref.messageId === "u2")).toBe(true);
		expect(pack.omitted.reason).toBeString();
	});
});

function toolJsonl(id: string, text: string): string {
	return [
		JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
		JSON.stringify({ type: "message", id, timestamp: "2026-07-02T00:00:10.000Z", message: { role: "tool", content: [{ type: "text", text }] } }),
	].join("\n");
}

describe("classifyNonUserText edge cases", () => {
	test("non-zero failure count like '3 pass 2 failures' is an issue", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: toolJsonl("t", "3 pass 2 failures") });
		expect(result.nodes.some((n) => n.kind === "issue")).toBe(true);
		expect(result.nodes.some((n) => n.kind === "evidence")).toBe(false);
	});

	test("mixed output with a zero-failure line plus a real error is an issue", () => {
		const text = "Unit: 0 failures\nE2E: exit 1 error";
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: toolJsonl("t", text) });
		expect(result.nodes.some((n) => n.kind === "issue")).toBe(true);
	});

	test("inflected 'Tests FAILED' creates an issue node instead of being skipped", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: toolJsonl("t", "Tests FAILED") });
		expect(result.nodes.some((n) => n.kind === "issue")).toBe(true);
	});

	test("inflected '2 errors found' creates an issue node instead of being skipped", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: toolJsonl("t", "2 errors found") });
		expect(result.nodes.some((n) => n.kind === "issue")).toBe(true);
	});

	test("evidence title prefers test result summary line", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: toolJsonl("t", "bun test foo.test.ts\n10 pass 0 fail 12 expect() calls") });

		const evidence = result.nodes.find((n) => n.kind === "evidence");
		expect(evidence).toBeDefined();
		expect(evidence?.title).toContain("10 pass");
		expect(evidence?.title).toContain("12 expect");
	});
});

describe("toolResult content coverage (Phase 1 gap)", () => {
	test("file read output becomes an evidence node", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-read", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "export function createSession() {\n  const store = new Map();\n  return store;\n}" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		const node = result.nodes.find((n) => n.sourceMessageId === "tr-read");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("evidence");
	});

	test("grep match output becomes an evidence node", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-grep", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "apps/web/src/lib/store.ts:357: async createSession(opts) {" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		const node = result.nodes.find((n) => n.sourceMessageId === "tr-grep");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("evidence");
	});

	test("write success output becomes an evidence node", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-write", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "Successfully wrote to apps/web/src/lib/store.ts (44 lines)" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		const node = result.nodes.find((n) => n.sourceMessageId === "tr-write");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("evidence");
	});

	test("bash command output with no pass/fail keywords becomes an evidence node", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-bash", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "total 48\ndrwxr-xr-x  6 hyan  staff  192 Jul  8 12:00 dist\n-rw-r--r--  1 hyan  staff  2200 Jul  8 12:00 index.html" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		const node = result.nodes.find((n) => n.sourceMessageId === "tr-bash");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("evidence");
	});

	test("assistant message with code block becomes a resolution node", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "a-code", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "I refactored the function like this:\n\n```typescript\nconst createInFlight = new Map();\n```" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		const node = result.nodes.find((n) => n.sourceMessageId === "a-code");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("resolution");
	});

	test("trivial toolResult (single word) is still skipped", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-ok", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		expect(result.nodes.find((n) => n.sourceMessageId === "tr-ok")).toBeUndefined();
	});

	test("assistant prose mentioning 'import' without code is not overclassified", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "a-prose", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will import the data from the API and process it." }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		expect(result.nodes.find((n) => n.sourceMessageId === "a-prose")).toBeUndefined();
	});

	test("Path not found toolResult becomes an issue node", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-404", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "Path not found: /nonexistent/file.ts" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		const node = result.nodes.find((n) => n.sourceMessageId === "tr-404");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("issue");
	});
});

describe("toolResult noise filtering", () => {
	test("[Superseded by a newer read of this file] is skipped", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-sup", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "[Superseded by a newer read of this file]" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		expect(result.nodes.find((n) => n.sourceMessageId === "tr-sup")).toBeUndefined();
	});

	test("Skipped due to queued user message is skipped", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-skip", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "Skipped due to queued user message. Do not count this skipped result as completed work or verification." }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		expect(result.nodes.find((n) => n.sourceMessageId === "tr-skip")).toBeUndefined();
	});
	test("(no output) with trailing wall-time is skipped", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr-empty", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "(no output)\n\nWall time: 0.00 seconds" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });
		expect(result.nodes.find((n) => n.sourceMessageId === "tr-empty")).toBeUndefined();
	});

	// TODO: bare numeric wc-style output like "3\n3\n691 /path\n\nWall time: ..."
	// passes the >20 char threshold and becomes evidence. Needs a more precise filter.
});

describe("extractor role and edge generation", () => {
	test("toolResult role with passing test output is classified as evidence with a test artifact", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "tr1", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "bun test apps/server/src/session-context.test.ts\n10 pass 0 fail" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });

		expect(result.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "evidence", sourceMessageId: "tr1" }),
		]));
		expect(result.artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "test", ref: "bun test apps/server/src/session-context.test.ts" }),
		]));
	});

	test("consecutive user goals create a continues edge from the later goal to the previous goal", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "g1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Set up the memory topology graph" }] } }),
			JSON.stringify({ type: "message", id: "g2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "Add embedding similarity to the topology graph" }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });

		const goals = result.nodes.filter((n) => n.kind === "goal");
		expect(goals.length).toBe(2);
		const first = goals.find((n) => n.sourceMessageId === "g1");
		const second = goals.find((n) => n.sourceMessageId === "g2");
		const continues = result.edges.find((edge) =>
			edge.relation === "continues" &&
			edge.sourceNodeId === second?.id &&
			edge.targetNodeId === first?.id,
		);
		expect(continues).toBeDefined();
	});

	test("assistant decision after a user goal creates a depends_on edge to that goal", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "g1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Design the storage layout for the topology" }] } }),
			JSON.stringify({ type: "message", id: "d1", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "I recommend using a single SQLite table with an embedding column." }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });

		const goal = result.nodes.find((n) => n.kind === "goal");
		const decision = result.nodes.find((n) => n.kind === "decision");
		expect(goal).toBeDefined();
		expect(decision).toBeDefined();
		const dependsOn = result.edges.find((edge) =>
			edge.relation === "depends_on" &&
			edge.sourceNodeId === decision?.id &&
			edge.targetNodeId === goal?.id,
		);
		expect(dependsOn).toBeDefined();
	});

	test("skill-doc toolResult with YAML frontmatter is not classified as decision", () => {
		const content = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "sd1", timestamp: "2026-07-02T00:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "---\nname: memory-topology\ndescription: Skill for architecture and recommendation of the memory graph.\n---\nUse this skill to recall the topology." }] } }),
		].join("\n");
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content });

		expect(result.nodes.some((n) => n.kind === "decision")).toBe(false);
	});
});

describe("renderSessionContextPack budget coherence", () => {
	test("tiny budget yields a valid pack with coherent omitted counts", () => {
		const big = "我希望" + "x".repeat(1300);
		const extracted = extractSessionContextFromJsonl({
			sessionId: "s1",
			content: [
				JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: big }] } }),
				JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "small goal" }] } }),
				JSON.stringify({ type: "message", id: "u3", timestamp: "2026-07-02T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "another small goal" }] } }),
			].join("\n"),
		});
		const pack = renderSessionContextPack({ sessionId: "s1", query: "", budget: 10, ...extracted });

		expect(typeof pack.summary).toBe("string");
		const selectedCount =
			pack.goals.length + pack.constraints.length + pack.decisions.length +
			pack.issues.length + pack.resolutions.length + pack.evidence.length + pack.openTodos.length;
		expect(selectedCount).toBeGreaterThanOrEqual(1);
		expect(pack.omitted.nodeCount).toBe(extracted.nodes.length - selectedCount);
		expect(pack.omitted.nodeCount).toBeGreaterThanOrEqual(0);
		if (pack.omitted.nodeCount > 0) expect(pack.omitted.reason).toBe("budget");
	});
});

const tempDirs: string[] = [];

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-context-service-"));
	tempDirs.push(dir);
	return dir;
}

test("rebuilds context store from a session file", async () => {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });
	const sessionFile = path.join(dir, "s1.jsonl");
	fs.writeFileSync(sessionFile, jsonl);

	const rebuilt = await rebuildSessionContextFromFile({ sessionId: "s1", sessionFile });

	expect(rebuilt.nodeCount).toBeGreaterThan(0);
	expect(rebuilt.sourcePath).toBe(sessionFile);
	const graph = getSessionContextGraph("s1", 50);
	expect(graph.nodes.length).toBe(rebuilt.nodeCount);
});

const jsonlSkip = [
	JSON.stringify({ type: "session", version: 3, id: "s-skip", cwd: "/repo", timestamp: "2026-07-09T00:00:00.000Z" }),
	JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-09T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Add regression test for topology rebuild" }] } }),
	JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-09T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "Actually, we must validate FK constraints instead" }] } }),
	JSON.stringify({ type: "message", id: "tool1", timestamp: "2026-07-09T00:00:03.000Z", message: { role: "tool", content: [{ type: "text", text: "bun test apps/server/src/session-context.test.ts\n10 pass" }] } }),
].join("\n");

function makeSkipFakeClient(skipId: string): TopologyExtractorModelClient {
	return {
		async extractNodes(input) {
			const parsed = JSON.parse(input.prompt) as Array<{ id: string; kind: string; title: string; body: string; role: string }>;
			return {
				nodes: parsed.map((n) => ({
					id: n.id,
					kind: n.id === skipId ? "skip" : n.kind,
					title: n.title,
					body: n.body,
				})),
			};
		},
	};
}

test("rebuild prunes edges and artifacts referencing LLM-skipped nodes without FK violation", async () => {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });
	const sessionFile = path.join(dir, "s-skip.jsonl");
	fs.writeFileSync(sessionFile, jsonlSkip);

	// The regex extractor produces node IDs via makeNode:
	//   ${sessionId}:${kind}:${turnIndex}:${messageId}
	// u1 = goal at turn 1   → s-skip:goal:1:u1
	// u2 = user_intent turn 2 → s-skip:user_intent:2:u2
	const skippedGoalId = "s-skip:goal:1:u1";
	const fakeClient = makeSkipFakeClient(skippedGoalId);

	const rebuilt = await rebuildSessionContextFromFile({
		sessionId: "s-skip",
		sessionFile,
		extractorClient: fakeClient,
		extractorModelRole: "topology_extractor",
	});

	// The skipped goal node is pruned. Surviving nodes: user_intent + evidence = 2.
	expect(rebuilt.nodeCount).toBe(2);
	expect(rebuilt.edgeCount).toBe(0);

	const graph = getSessionContextGraph("s-skip", 50);
	expect(graph.nodes.length).toBe(2);

	// No edge must reference the skipped node.
	expect(graph.edges).toHaveLength(0);
	for (const edge of graph.edges) {
		expect(edge.sourceNodeId).not.toBe(skippedGoalId);
		expect(edge.targetNodeId).not.toBe(skippedGoalId);
	}

	// Artifacts on surviving nodes remain; none reference the skipped node.
	expect(graph.artifacts.length).toBeGreaterThan(0);
	for (const artifact of graph.artifacts) {
		expect(artifact.nodeId).not.toBe(skippedGoalId);
	}
});

describe("context replacement", () => {
	const RERANK_ENV_KEYS = [
		"OMP_DECK_TOPOLOGY_RERANK_ENABLED",
		"OMP_DECK_TOPOLOGY_RERANK_PROVIDER",
		"OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES",
		"OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT",
		"OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW",
	] as const;
	function withModelRoleRerankEnv<T>(fn: () => Promise<T>): Promise<T> {
		const saved: Record<string, string | undefined> = {};
		for (const k of RERANK_ENV_KEYS) saved[k] = process.env[k];
		process.env.OMP_DECK_TOPOLOGY_RERANK_ENABLED = "1";
		process.env.OMP_DECK_TOPOLOGY_RERANK_PROVIDER = "model_role";
		process.env.OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES = "1";
		process.env.OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT = "0";
		process.env.OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW = "1";
		return fn().finally(() => {
			for (const k of RERANK_ENV_KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k]!;
			}
		});
	}
	test("shouldReplaceContext triggers at or above 15%", () => {
		expect(shouldReplaceContext(14, 15)).toBe(false);
		expect(shouldReplaceContext(15, 15)).toBe(true);
		expect(shouldReplaceContext(50, 15)).toBe(true);
		expect(shouldReplaceContext(null, 15)).toBe(false);
		expect(shouldReplaceContext(undefined, 15)).toBe(false);
	});

	test("renderPackAsCompactFocus formats goals constraints decisions", () => {
		const pack: SessionContextPackResponse = {
			sessionId: "s1",
			query: "",
			budget: 1000,
			summary: "",
			goals: [
				{ id: "g1", sessionId: "s1", kind: "goal", sourceMessageId: "m1", sourceTurnIndex: 1, title: "A", body: "A", compressedBody: "Build X", importance: 1, createdAt: "", metadata: {} },
			],
			constraints: [
				{ id: "c1", sessionId: "s1", kind: "constraint", sourceMessageId: "m2", sourceTurnIndex: 2, title: "C", body: "C", compressedBody: "No React", importance: 1, createdAt: "", metadata: {} },
			],
			decisions: [],
			issues: [],
			resolutions: [],
			evidence: [],
			artifacts: [],
			openTodos: [],
			rawRefs: [],
			omitted: { nodeCount: 0, edgeCount: 0, reason: "none" },
		};
		const focus = renderPackAsCompactFocus(pack);
		expect(focus).toContain("Build X");
		expect(focus).toContain("No React");
		expect(focus).toContain("Preserve these key session facts");
	});

	test("renderPackAsCompactFocus returns empty for empty pack", () => {
		const pack: SessionContextPackResponse = {
			sessionId: "s1",
			query: "",
			budget: 1000,
			summary: "",
			goals: [],
			constraints: [],
			decisions: [],
			issues: [],
			resolutions: [],
			evidence: [],
			artifacts: [],
			openTodos: [],
			rawRefs: [],
			omitted: { nodeCount: 0, edgeCount: 0, reason: "none" },
		};
		expect(renderPackAsCompactFocus(pack)).toBe("");
	});

	test("renderTopologyGraphAsCompactFocus sends clean topology json without scores", () => {
		const graph: SessionContextGraphResponse = {
			sessionId: "s1",
			nodes: [
				{ id: "n1", sessionId: "s1", kind: "goal", sourceMessageId: "m1", sourceTurnIndex: 1, title: "Goal", body: "Build graph memory", compressedBody: "Build graph memory", importance: 1, createdAt: "", metadata: { confidence: 0.9 } },
				{ id: "n2", sessionId: "s1", kind: "evidence", sourceMessageId: "m2", sourceTurnIndex: 2, title: "Evidence", body: "Tests passed", compressedBody: "Tests passed", importance: 0.8, createdAt: "", metadata: {} },
			],
			edges: [
				{ id: "n1:verified_by:n2", sessionId: "s1", sourceNodeId: "n1", targetNodeId: "n2", relation: "verified_by", weight: 0.9, evidenceMessageId: "m2", metadata: {} },
			],
			artifacts: [
				{ id: "a1", sessionId: "s1", nodeId: "n2", kind: "test", ref: "bun test", label: "targeted test", metadata: {} },
			],
			totalNodes: 2,
			truncated: false,
		};
		const focus = renderTopologyGraphAsCompactFocus(graph, "current question");
		expect(focus).toContain("<session_topology_subgraph>");
		expect(focus).toContain("verified_by");
		expect(focus).not.toContain("importance");
		expect(focus).not.toContain("weight");
		expect(focus).not.toContain("confidence");
		const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
		expect(json).toBeDefined();
		const payload = JSON.parse(json!);
		expect(payload.nodes).toEqual([{ id: "n1", kind: "goal", title: "Goal", body: "Build graph memory", source: { messageId: "m1", turnIndex: 1 } }, { id: "n2", kind: "evidence", title: "Evidence", body: "Tests passed", source: { messageId: "m2", turnIndex: 2 } }]);
		expect(payload.edges).toEqual([{ sourceNodeId: "n1", relation: "verified_by", targetNodeId: "n2" }]);
	});

	test("renderRetrievedTopologyAsFocus injects query-matched snippet missing from compressedBody", () => {
		const filler = "x".repeat(320);
		const answer = "siliconflow rerank endpoint bge-reranker-v2-m3";
		const graph: SessionContextGraphResponse = {
			sessionId: "s1",
			nodes: [
				{
					id: "n1",
					sessionId: "s1",
					kind: "evidence",
					sourceMessageId: "m1",
					sourceTurnIndex: 1,
					title: "Rerank adapter",
					body: `${filler} ${answer}`,
					compressedBody: filler,
					importance: 0.9,
					createdAt: "",
					metadata: {},
				},
			],
			edges: [],
			artifacts: [],
			totalNodes: 1,
			truncated: false,
		};
		const retrieved: RetrievedTopology = {
			selectedNodeIds: ["n1"],
			selectedEdgeIds: [],
			candidateNodeIds: ["n1"],
			candidateEdgeIds: [],
			rankedCandidateNodeIds: ["n1"],
			ranking: [],
			artifacts: [],
			omitted: { nodeCount: 0, edgeCount: 0, reason: "none" },
			candidateNodeCount: 1,
		};
		const focus = renderRetrievedTopologyAsFocus(graph, "s1", "siliconflow rerank", retrieved);
		const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
		expect(json).toBeDefined();
		const payload = JSON.parse(json!);
		expect(payload.nodes[0].body).toContain("siliconflow");
	});

	test("combined hard case: IDF picks answer node from generic crowd AND renderer exposes hidden answer", () => {
		const query = "topology env file url provider rerank siliconflow";
		const genericNodes = Array.from({ length: 20 }, (_, i) => ({
			id: `generic_${i}`,
			sessionId: "s1",
			kind: "evidence" as const,
			sourceMessageId: `m_g_${i}`,
			sourceTurnIndex: 1,
			title: `topology env file url provider generic ${i}`,
			body: "topology env file url provider status report " + "x".repeat(400),
			compressedBody: "topology env file url provider status report " + "x".repeat(200),
			importance: 0.85,
			createdAt: "2026-07-03T00:00:00.000Z",
			metadata: {},
		}));
		const answerBody = "topology provider siliconflow rerank endpoint configured at /v1/rerank with bge-reranker-v2-m3";
		const filler = "y".repeat(320);
		const answerNode = {
			id: "answer",
			sessionId: "s1",
			kind: "evidence" as const,
			sourceMessageId: "m_a",
			sourceTurnIndex: 1,
			title: "topology provider siliconflow rerank endpoint",
			body: `${filler} ${answerBody}`,
			compressedBody: filler,
			importance: 0.85,
			createdAt: "2026-07-03T00:00:00.000Z",
			metadata: {},
		};
		const graph: SessionContextGraphResponse = {
			sessionId: "s1",
			nodes: [...genericNodes, answerNode],
			edges: [],
			artifacts: [],
			totalNodes: genericNodes.length + 1,
			truncated: false,
		};
		const retrieved = retrieveTopology(
			{ sessionId: "s1", query, candidateNodeLimit: 5, outputNodeLimit: 1, expansionHops: 1, outputEdgeLimit: 0, outputArtifactLimit: 0 },
			graph,
		);
		expect(retrieved).toBeDefined();
		expect(retrieved!.selectedNodeIds[0]).toBe("answer");
		const focus = renderRetrievedTopologyAsFocus(graph, "s1", query, retrieved!);
		const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
		expect(json).toBeDefined();
		const payload = JSON.parse(json!);
		expect(payload.nodes[0].body).toContain("siliconflow");
		expect(payload.nodes[0].body).toContain("bge-reranker-v2-m3");
	});

	test("getStoredQueryTopologyFocus applies an injected rerank patch and keeps focus clean", async () => {
		await withModelRoleRerankEnv(async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const sessionFile = path.join(dir, "s_rerank.jsonl");
			fs.writeFileSync(sessionFile, [
				JSON.stringify({ type: "session", version: 3, id: "s_rerank", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "topology rerank plan" }] } }),
				JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "please keep this deliberately unrelated external API patch validation node" }] } }),
			].join("\n"));
			await rebuildSessionContextFromFile({ sessionId: "s_rerank", sessionFile });
			const graph = getSessionContextGraph("s_rerank", 200);
			const localFocus = await getStoredQueryTopologyFocus({ sessionId: "s_rerank", query: "unmatched-rerank-trigger", contextPercent: 99, rerankClient: { rerankTopology: async () => undefined } });
			const localJson = localFocus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
			expect(localJson).toBeDefined();
			const localPayload = JSON.parse(localJson!);
			const keep = graph.nodes.find((node) => node.id !== localPayload.nodes[0].id);
			expect(keep).toBeDefined();

			const focus = await getStoredQueryTopologyFocus({
				sessionId: "s_rerank",
				query: "unmatched-rerank-trigger",
				contextPercent: 99,
				rerankClient: { rerankTopology: async () => ({ keepNodeIds: [keep!.id], keepEdgeIds: [], demoteNodeIds: [] }) },
			});

			const json = focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
			expect(json).toBeDefined();
			const payload = JSON.parse(json!);
			expect(payload.nodes[0].id).toBe(keep!.id);
			expect(JSON.stringify(payload)).not.toContain("score");
			expect(JSON.stringify(payload)).not.toContain("reasons");
			expect(JSON.stringify(payload)).not.toContain("importance");
		});
	});

	test("getStoredQueryTopologyFocus falls back to local focus when injected rerank patch is invalid", async () => {
		await withModelRoleRerankEnv(async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const sessionFile = path.join(dir, "s_invalid_rerank.jsonl");
			fs.writeFileSync(sessionFile, [
				JSON.stringify({ type: "session", version: 3, id: "s_invalid_rerank", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
				JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "topology rerank fallback local baseline" }] } }),
			].join("\n"));
			await rebuildSessionContextFromFile({ sessionId: "s_invalid_rerank", sessionFile });

			const localFocus = await getStoredQueryTopologyFocus({ sessionId: "s_invalid_rerank", query: "topology", contextPercent: 99, rerankClient: { rerankTopology: async () => undefined } });
			const fallbackFocus = await getStoredQueryTopologyFocus({ sessionId: "s_invalid_rerank", query: "topology", contextPercent: 99, rerankClient: { rerankTopology: async () => ({ keepNodeIds: ["missing"], keepEdgeIds: [], demoteNodeIds: [] }) } });

			expect(fallbackFocus).toBe(localFocus);
		});
	});
	test("getStoredQueryTopologyFocus flips first node when embedding path is enabled", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "s_embed_flip.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "s_embed_flip", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "alpha component setup" }] } }),
			JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "beta service config" }] } }),
		].join("\n"));
		await rebuildSessionContextFromFile({ sessionId: "s_embed_flip", sessionFile });

		// Point managed env to temp dir so getEmbeddingConfig reads an empty file
		const savedDataDir = process.env.OMP_DECK_DATA_DIR;
		process.env.OMP_DECK_DATA_DIR = dir;

		const embedKeys = [
			"OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED",
			"OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL",
			"OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY",
			"OMP_DECK_TOPOLOGY_EMBEDDING_MODEL",
			"OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH",
		] as const;
		const savedEmbedEnv: Record<string, string | undefined> = {};
		for (const k of embedKeys) savedEmbedEnv[k] = process.env[k];

		let fetchCalls = 0;
		const originalFetch = globalThis.fetch;

		try {
			// Phase A: embedding disabled → local lexical path
			// Query "alpha" matches node u1 ("alpha component setup") via token match
			for (const k of embedKeys) delete process.env[k];
			const localFocus = await getStoredQueryTopologyFocus({
				sessionId: "s_embed_flip",
				query: "alpha",
				contextPercent: 99,
				rerankClient: { rerankTopology: async () => undefined },
			});
			expect(localFocus).toContain("<session_topology_subgraph>");
			const localJson = localFocus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
			expect(localJson).toBeDefined();
			const localPayload = JSON.parse(localJson!);
			// Local: token match picks alpha node (u1) first
			expect(localPayload.nodes[0].source.messageId).toBe("u1");

			// Phase B: embedding enabled with mocked fetch
			// Mock makes query "alpha" embedding closest to "beta" node (vector flip)
			process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED = "1";
			process.env.OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL = "http://mock-embed";
			process.env.OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY = "test";
			process.env.OMP_DECK_TOPOLOGY_EMBEDDING_MODEL = "test-model";
			process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH = "/embeddings";

			(globalThis as { fetch: typeof fetch }).fetch = (async (_input: Request | string, init?: RequestInit) => {
				fetchCalls++;
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				const texts: string[] = body.input ?? [];
				const data = texts.map((text) => {
					const t = String(text).toLowerCase();
					let embedding: number[];
					if (t === "alpha") embedding = [1.0, 0.0, 0.0]; // query direction
					else if (t.includes("alpha")) embedding = [0.1, 0.9, 0.0]; // alpha node: far from query
					else if (t.includes("beta")) embedding = [0.95, 0.05, 0.0]; // beta node: close to query
					else embedding = [0.0, 0.0, 1.0];
					return { object: "embedding", embedding, index: 0 };
				});
				return new Response(JSON.stringify({ id: "emb", object: "list", data, usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { "content-type": "application/json" } });
			}) as typeof fetch;

			const embedFocus = await getStoredQueryTopologyFocus({
				sessionId: "s_embed_flip",
				query: "alpha",
				contextPercent: 99,
				rerankClient: { rerankTopology: async () => undefined },
			});
			expect(fetchCalls).toBeGreaterThan(0);
			const embedJson = embedFocus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)?.[1];
			expect(embedJson).toBeDefined();
			const embedPayload = JSON.parse(embedJson!);
			// Embedding: cosine picks beta node (u2) first
			expect(embedPayload.nodes[0].source.messageId).toBe("u2");
		} finally {
			if (savedDataDir === undefined) delete process.env.OMP_DECK_DATA_DIR;
			else process.env.OMP_DECK_DATA_DIR = savedDataDir;
			for (const [k, v] of Object.entries(savedEmbedEnv)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			globalThis.fetch = originalFetch;
		}
	});
	test("retrieveTopologyWithEmbeddings selects nodes in cosine-score order, not DB order", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "s_cosine.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", version: 3, id: "s_cosine", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
			JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "GC bias detail path test" }] } }),
			JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "sample selection ok" }] } }),
			JSON.stringify({ type: "message", id: "u3", timestamp: "2026-07-02T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "figure y axis label wrong" }] } }),
		].join("\n"));
		await rebuildSessionContextFromFile({ sessionId: "s_cosine", sessionFile });
		const graph = getSessionContextGraph("s_cosine", 200);
		expect(graph.nodes.length).toBe(3);

		// Text-aware mock: key embeddings on actual node text content
		// (embed text is `${kind}: ${title} — ${compressedBody || body}`)
		const originalFetch = globalThis.fetch;
		(globalThis as { fetch: typeof fetch }).fetch = (async (input: Request | string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			const texts: string[] = body.input ?? [];
			const data = texts.map((text) => {
				const t = String(text).toLowerCase();
				let embedding: number[];
				if (t.includes("gc bias")) embedding = [0.9, 0.1, 0.0];
				else if (t.includes("sample")) embedding = [0.2, 0.8, 0.1];
				else if (t.includes("figure")) embedding = [0.1, 0.1, 0.9];
				else embedding = [0.0, 0.0, 0.0];
				return { object: "embedding", embedding, index: 0 };
			});
			return new Response(JSON.stringify({ id: "emb", object: "list", data, usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		const config: EmbeddingConfig = { baseUrl: "http://mock", endpointPath: "/embeddings", apiKey: "test", model: "test-model", timeoutMs: 5000 };
		try {
			// outputNodeLimit: 2 < 3 nodes — forces a selection decision
			// Old (DB-order) code would drop the GC bias node (earliest created_at)
			// New (score-order) code keeps GC bias node (highest cosine to query)
			const result = await retrieveTopologyWithEmbeddings(
				{ sessionId: "s_cosine", query: "GC bias", candidateNodeLimit: 5, expansionHops: 1, outputNodeLimit: 2, outputEdgeLimit: 5, outputArtifactLimit: 3 },
				graph,
				config,
			);
			expect(result).toBeDefined();

			const titleById = new Map(graph.nodes.map((n) => [n.id, n.title]));
			const selectedTitles = result!.selectedNodeIds.map((id) => titleById.get(id) ?? "");

			// GC bias node must be selected (highest cosine to query)
			expect(selectedTitles.some((t) => t.includes("GC bias"))).toBe(true);
			// Figure node must be dropped (lowest cosine, would be kept under old DB-order)
			expect(selectedTitles.some((t) => t.includes("figure"))).toBe(false);
			// Ordering: GC bias first, sample second
			expect(selectedTitles[0]).toContain("GC bias");
			expect(selectedTitles[1]).toContain("sample");

			const stored = getNodeEmbeddings("s_cosine");
			expect(stored.size).toBe(graph.nodes.length);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	});

