/**
 * T2: Edge Construction — topology relationships
 *
 * Tests:
 *   - Goal → Decision: depends_on edge created
 *   - Goal continuation: continues edge between consecutive goals
 *   - Unrelated goals: NO edge created (contamination prevention)
 *   - Edge precision: no spurious edges
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { FIXTURES } from "./golden/fixtures.ts";
import type { GoldenFixture, ExpectedEdge } from "./golden/fixtures.ts";
import type { TopologyEdge, TopologyNode } from "../src/types.ts";

function toAgentMessages(fixture: GoldenFixture): Record<string, unknown>[] {
	return fixture.messages.map((m, i) => ({
		role: m.role,
		content: [{ type: "text", text: m.content }],
		id: m.id ?? `msg-${i}`,
		timestamp: m.timestamp ?? new Date(Date.now() + i * 1000).toISOString(),
	}));
}

function findEdge(
	edges: TopologyEdge[],
	nodes: TopologyNode[],
	expected: ExpectedEdge,
): TopologyEdge | undefined {
	const source = nodes.find((n) => n.title.toLowerCase().includes(expected.from_title_contains.toLowerCase()));
	const target = nodes.find((n) => n.title.toLowerCase().includes(expected.to_title_contains.toLowerCase()));
	if (!source || !target) return undefined;
	return edges.find((e) =>
		e.sourceNodeId === source.id &&
		e.targetNodeId === target.id &&
		e.relation === expected.relation,
	);
}

describe("T2: Edge Construction", () => {
	// ── Expected edges present ──────────────────────────────────────────
	for (const fixture of FIXTURES) {
		if (fixture.messages.length === 0 || fixture.expected_edges.length === 0) continue;

		test(`[${fixture.id}] expected edges present`, async () => {
			const result = await extractFromMessages("test", toAgentMessages(fixture));
			for (const expected of fixture.expected_edges) {
				const edge = findEdge(result.edges, result.nodes, expected);
				expect(edge, `Expected edge [${expected.relation}] from "${expected.from_title_contains}" to "${expected.to_title_contains}"`).toBeDefined();
			}
		});
	}

	// ── Negative test: unrelated goals have NO edge ─────────────────────
	test("[s8-unrelated-projects] no spurious edges between unrelated goals", async () => {
		const fixture = FIXTURES.find((f) => f.id === "s8-unrelated-projects")!;
		const result = await extractFromMessages("test", toAgentMessages(fixture));
		expect(result.edges.length).toBe(0);
	});

	// ── Edge precision: no unexpected edges across all fixtures ─────────
	test("edge precision: no spurious edges in any fixture", async () => {
		for (const fixture of FIXTURES) {
			if (fixture.messages.length === 0) continue;
			const result = await extractFromMessages("test", toAgentMessages(fixture));

			// Every edge must be justified by an expected_edge
			for (const edge of result.edges) {
				const isExpected = fixture.expected_edges.some((expected) => {
					const found = findEdge(result.edges, result.nodes, expected);
					return found?.id === edge.id;
				});
				// Allow continues edges between goals (structural, not always in expected_edges)
				const sourceNode = result.nodes.find((n) => n.id === edge.sourceNodeId);
				const targetNode = result.nodes.find((n) => n.id === edge.targetNodeId);
				const isGoalContinuation = edge.relation === "continues" &&
					sourceNode?.kind === "goal" && targetNode?.kind === "goal";
				const isDecisionDepends = edge.relation === "depends_on" &&
					sourceNode?.kind === "decision" && targetNode?.kind === "goal";
				const isSupersedes = edge.relation === "supersedes" &&
					sourceNode?.kind === "user_intent" && targetNode?.kind === "user_intent";
				const isResolvedBy = edge.relation === "resolved_by" &&
					sourceNode?.kind === "issue" && targetNode?.kind === "resolution";
				const isVerifiedBy = edge.relation === "verified_by" &&
					sourceNode?.kind === "resolution" && targetNode?.kind === "evidence";

				expect(isExpected || isGoalContinuation || isDecisionDepends || isSupersedes || isResolvedBy || isVerifiedBy).toBe(true);
			}
		}
	});

	// ── Goal → Decision edge ────────────────────────────────────────────
	test("goal→decision creates depends_on edge", async () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "目标是减少 memory token" }], id: "u1", timestamp: new Date().toISOString() },
			{ role: "assistant", content: [{ type: "text", text: "方案选择 topology compression。推荐 IDF 评分。" }], id: "a1", timestamp: new Date().toISOString() },
		];
		const result = await extractFromMessages("test", messages as Record<string, unknown>[]);
		const goal = result.nodes.find((n) => n.kind === "goal");
		const decision = result.nodes.find((n) => n.kind === "decision");
		expect(goal).toBeDefined();
		expect(decision).toBeDefined();
		const edge = result.edges.find((e) =>
			e.sourceNodeId === decision!.id && e.targetNodeId === goal!.id && e.relation === "depends_on",
		);
		expect(edge).toBeDefined();
	});
});
