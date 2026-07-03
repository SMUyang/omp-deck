import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import { getSessionContextGraph } from "./db/session-context.ts";
import { extractSessionContextFromJsonl, rebuildSessionContextFromFile, renderSessionContextPack } from "./session-context.ts";

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

	test("pure zero-failure summary remains evidence", () => {
		const result = extractSessionContextFromJsonl({ sessionId: "s1", content: toolJsonl("t", "bun test foo.test.ts\n10 pass 0 fail") });
		expect(result.nodes.some((n) => n.kind === "evidence")).toBe(true);
		expect(result.nodes.some((n) => n.kind === "issue")).toBe(false);
	});
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

import { renderPackAsCompactFocus, shouldReplaceContext } from "./session-context.ts";
import type { SessionContextPackResponse } from "@omp-deck/protocol";

describe("context replacement", () => {
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
});
