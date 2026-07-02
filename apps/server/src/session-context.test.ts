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
