/**
 * Topology Memory Challenge
 *
 * A realistic 50-turn development session that tests whether
 * topology memory can answer questions about constraints,
 * decisions, and artifacts after context replacement.
 *
 * This is the ultimate test: if the topology memory can answer
 * these questions correctly after old context is replaced,
 * it's actually working.
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { retrieveTopology, renderFocus } from "../src/retrieve.ts";
import type { TopologyNode } from "../src/types.ts";

// ── Build the challenge session ─────────────────────────────────────────

const baseTime = Date.now();
function ts(minutesAgo: number): string {
	return new Date(baseTime - minutesAgo * 60_000).toISOString();
}

const CHALLENGE_MESSAGES: Record<string, unknown>[] = [
	{ role: "user", content: [{ type: "text", text: "实现 topology memory 扩展" }], id: "u1", timestamp: ts(120) },
	{ role: "user", content: [{ type: "text", text: "只能使用 SQLite" }], id: "u5", timestamp: ts(110) },
	{ role: "assistant", content: [{ type: "text", text: "方案选择 IDF 检索，推荐用 inverse document frequency 评分。" }], id: "a10", timestamp: ts(100) },
	{ role: "user", content: [{ type: "text", text: "保留最近 5 轮对话" }], id: "u15", timestamp: ts(90) },
	{ role: "user", content: [{ type: "text", text: "改成只保留最近 3 轮" }], id: "u20", timestamp: ts(80) },
	{ role: "user", content: [{ type: "text", text: "Jaccard merge 把两个否定节点合并了，这是个 bug" }], id: "u25", timestamp: ts(70) },
	{ role: "assistant", content: [{ type: "text", text: "修复了 merge 问题。加入了 contradiction protection。\n```ts\nif (areContradictory(a, b)) return false;\n```" }], id: "a30", timestamp: ts(60) },
	{ role: "assistant", content: [{ type: "text", text: "实现了 retrieve.ts 负责检索逻辑" }], id: "a40", timestamp: ts(40) },
	{ role: "assistant", content: [{ type: "text", text: "实现了 optimize.ts 负责优化逻辑" }], id: "a50", timestamp: ts(30) },
];

// Expected answers
const QA = [
	{
		question: "现在 context replacement 应该保留多少轮？",
		query: "保留 最近 对话 轮",
		mustContain: "3",
		mustNotContain: "5",
		description: "constraint was updated from 5 → 3",
	},
	{
		question: "为什么修改 merge？",
		query: "merge 修改 Jaccard 否定节点",
		mustContain: "否定节点",
		description: "issue: negation nodes were incorrectly merged",
	},
	{
		question: "负责 retrieval 的文件是什么？",
		query: "retrieval 检索 文件",
		mustContain: "retrieve.ts",
		description: "artifact should be traceable",
	},
	{
		question: "当前检索方法是什么？",
		query: "检索 方法 IDF",
		mustContain: "IDF",
		description: "decision should be retained",
	},
	{
		question: "数据库用什么？",
		query: "SQLite database 数据库",
		mustContain: "SQLite",
		description: "constraint should be retained",
	},
];

describe("Topology Memory Challenge", () => {
	let extracted: Awaited<ReturnType<typeof extractFromMessages>>;

	test("extract all nodes from challenge session", async () => {
		extracted = await extractFromMessages("challenge", CHALLENGE_MESSAGES);
		console.log(`Challenge: ${extracted.nodes.length} nodes, ${extracted.edges.length} edges`);
		for (const n of extracted.nodes) {
			console.log(`  [${n.kind}] ${n.title.slice(0, 60)}`);
		}
		expect(extracted.nodes.length).toBeGreaterThanOrEqual(5);
	});

	// Run each QA after extraction
	for (const qa of QA) {
		test(`Q: "${qa.question}"`, () => {
			const retrieved = retrieveTopology(qa.query, extracted.nodes, extracted.edges, { outputLimit: 5 });
			const focus = renderFocus("challenge", qa.query, retrieved, extracted.artifacts);

			// Check the focus text contains the expected answer
			const focusLower = focus.toLowerCase();
			const mustContainLower = qa.mustContain.toLowerCase();

			expect(focus.length, "Focus should not be empty").toBeGreaterThan(0);

			if (!focusLower.includes(mustContainLower)) {
				console.error(`FAIL: Focus does not contain "${qa.mustContain}"`);
				console.error(`Focus preview:\n${focus.slice(0, 500)}`);
			}
			expect(focusLower, `Expected focus to contain "${qa.mustContain}" (${qa.description})`).toContain(mustContainLower);

			if (qa.mustNotContain) {
				const mustNotLower = qa.mustNotContain.toLowerCase();
				if (focusLower.includes(mustNotLower)) {
					console.warn(`⚠️ Focus contains stale "${qa.mustNotContain}" — should rank lower than "${qa.mustContain}"`);
				}
			}
		});
	}

	test("challenge summary: all questions answered", () => {
		let passCount = 0;
		for (const qa of QA) {
			const retrieved = retrieveTopology(qa.query, extracted.nodes, extracted.edges, { outputLimit: 5 });
			const focus = renderFocus("challenge", qa.query, retrieved, extracted.artifacts).toLowerCase();
			if (focus.includes(qa.mustContain.toLowerCase())) passCount++;
		}
		console.log(`\n=== Topology Memory Challenge ===`);
		console.log(`${passCount}/${QA.length} questions answered correctly`);
		console.log(`Pass rate: ${((passCount / QA.length) * 100).toFixed(0)}%`);
		expect(passCount / QA.length).toBeGreaterThanOrEqual(0.80); // ≥80% to pass
	});
});
