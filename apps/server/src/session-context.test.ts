import { describe, expect, test } from "bun:test";

import { extractSessionContextFromJsonl, renderSessionContextPack } from "./session-context.ts";

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
