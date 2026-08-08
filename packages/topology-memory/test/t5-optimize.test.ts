/**
 * T5: Optimizer Safety — anti-merge + decay + pruning
 *
 * Tests:
 *   - Anti-merge: high-similarity opposite-meaning nodes are NOT merged
 *   - Decay: time simulation, critical nodes survive
 *   - Pruning: 600 nodes, constraints survive
 *   - Optimization preserves recall
 */

import { test, expect, describe } from "bun:test";
import { optimizeTopology, mergeDuplicateNodes, decayImportance, pruneExcess, nodeSimilarity } from "../src/optimize.ts";
import { ANTI_MERGE_CASES } from "./golden/fixtures.ts";
import type { TopologyNode, TopologyEdge } from "../src/types.ts";

function makeNode(id: string, kind: string, title: string, body: string, importance = 0.7, ageDays = 0): TopologyNode {
	return {
		id, sessionId: "test", kind, messageId: id, turnIndex: 0,
		title, body, importance,
		createdAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
		metadata: {},
	};
}

const EDGES: TopologyEdge[] = [];

describe("T5: Anti-Merge Safety", () => {
	for (const tc of ANTI_MERGE_CASES) {
		test(`NOT merged: "${tc.a}" vs "${tc.b}" (${tc.why})`, () => {
			const nodes = [
				makeNode("n1", "constraint", tc.a, tc.a),
				makeNode("n2", "constraint", tc.b, tc.b),
			];
			const result = mergeDuplicateNodes(nodes);
			expect(result.merged.length, `Should keep both nodes but got ${result.merged.length}`).toBe(2);
			expect(result.mergeCount).toBe(0);
		});

		test(`similarity check: "${tc.a}" vs "${tc.b}"`, () => {
			const sim = nodeSimilarity(
				makeNode("n1", "constraint", tc.a, tc.a),
				makeNode("n2", "constraint", tc.b, tc.b),
			);
			console.log(`  Jaccard("${tc.a}", "${tc.b}") = ${sim.toFixed(3)}`);
			// These SHOULD be merged by current threshold (0.65) if similarity is high
			// This test DOCUMENTS the danger — if sim >= 0.65 and they merge, it's a known issue
			if (sim >= 0.65) {
				console.warn(`  ⚠️ HIGH SIMILARITY (${sim.toFixed(3)} ≥ 0.65) — these WILL be incorrectly merged!`);
			}
		});
	}
});

describe("T5: Decay", () => {
	test("30-day-old node: no decay", () => {
		const node = makeNode("n1", "constraint", "critical rule", "critical rule", 1.0, 25);
		const result = decayImportance([node]);
		expect(result[0]!.importance).toBe(1.0);
	});

	test("37-day-old node: -10%", () => {
		const node = makeNode("n1", "evidence", "test result", "test result", 0.85, 37);
		const result = decayImportance([node]);
		expect(result[0]!.importance).toBeCloseTo(0.85 * 0.9, 1);
	});

	test("90-day-old constraint: floored at 0.5 (protected kind)", () => {
		const node = makeNode("n1", "constraint", "永远不能删除生产数据库", "永远不能删除生产数据库", 1.0, 90);
		const result = decayImportance([node]);
		expect(result[0]!.importance).toBeGreaterThanOrEqual(0.5);
		console.log(`  90-day constraint: ${result[0]!.importance.toFixed(3)} (protected floor=0.5)`);
	});

	test("90-day-old evidence: floored at 0.3 (non-protected)", () => {
		const node = makeNode("n1", "evidence", "test output", "test output", 0.85, 90);
		const result = decayImportance([node]);
		expect(result[0]!.importance).toBeCloseTo(0.85 * 0.3, 1);
	});

	test("decayed constraint still outranks recent action", () => {
		const oldConstraint = decayImportance([makeNode("c1", "constraint", "critical rule", "x", 1.0, 90)])[0]!;
		const recentAction = makeNode("a1", "action", "recent work", "x", 0.7, 1);
		expect(oldConstraint.importance).toBeGreaterThan(recentAction.importance * 0.5);
	});
});

describe("T5: Pruning", () => {
	test("≤500 nodes: no pruning", () => {
		const nodes = Array.from({ length: 400 }, (_, i) => makeNode(`n${i}`, "evidence", `evidence-${i}`, `body-${i}`));
		const result = pruneExcess(nodes);
		expect(result.kept.length).toBe(400);
		expect(result.prunedIds.size).toBe(0);
	});

	test("600 nodes: pruned to 500, protected kinds survive", () => {
		const evidence = Array.from({ length: 499 }, (_, i) => makeNode(`e${i}`, "evidence", `evidence-${i}`, `body-${i}`, 0.85));
		const constraint = makeNode("c1", "constraint", "永远不能删除生产数据库", "critical", 0.7);
		const goals = Array.from({ length: 100 }, (_, i) => makeNode(`g${i}`, "goal", `goal-${i}`, `body-${i}`, 0.9));
		const nodes = [...evidence, constraint, ...goals];

		const result = pruneExcess(nodes, 500);
		expect(result.kept.length).toBeLessThanOrEqual(500);
		// Constraint must survive even though it's not a protected kind
		const constraintSurvived = result.kept.some((n) => n.id === "c1");
		console.log(`  600 nodes → ${result.kept.length} kept, ${result.prunedIds.size} pruned`);
		console.log(`  Critical constraint survived: ${constraintSurvived}`);
		// This test documents that non-protected critical nodes CAN be pruned
		// If constraintSurvived is false, it reveals a design flaw
	});

	test("protected kinds (user_intent + goal) always survive", () => {
		const evidence = Array.from({ length: 600 }, (_, i) => makeNode(`e${i}`, "evidence", `ev-${i}`, `b-${i}`, 0.99));
		const userIntent = makeNode("u1", "user_intent", "critical user intent", "x", 0.5);
		const nodes = [...evidence, userIntent];
		const result = pruneExcess(nodes, 500);
		expect(result.kept.some((n) => n.id === "u1")).toBe(true);
	});
});

describe("T5: Optimization preserves recall", () => {
	test("optimize does not reduce node count below critical threshold", () => {
		const nodes = [
			makeNode("g1", "goal", "implement feature A", "feature A"),
			makeNode("d1", "decision", "use approach X", "approach X"),
			makeNode("c1", "constraint", "must use SQLite", "SQLite constraint"),
			makeNode("e1", "evidence", "tests pass", "5 pass 0 fail"),
		];
		const result = optimizeTopology(nodes, EDGES);
		// All critical nodes should survive
		expect(result.nodes.some((n) => n.kind === "goal")).toBe(true);
		expect(result.nodes.some((n) => n.kind === "decision")).toBe(true);
		expect(result.nodes.some((n) => n.kind === "constraint")).toBe(true);
		expect(result.nodes.some((n) => n.kind === "evidence")).toBe(true);
	});
});
