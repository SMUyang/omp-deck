/**
 * T3: Retrieval Benchmark — Hit@K + indirect recall
 *
 * Tests:
 *   - Direct retrieval: query finds the right node by text match
 *   - Indirect recall: query finds nodes via edge traversal
 *   - Hit@1, Hit@3, Hit@5 metrics
 *   - Stale memory: superseded nodes rank lower
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { retrieveTopology } from "../src/retrieve.ts";
import { FIXTURES } from "./golden/fixtures.ts";
import type { GoldenFixture } from "./golden/fixtures.ts";
import type { TopologyNode } from "../src/types.ts";

function toAgentMessages(fixture: GoldenFixture): Record<string, unknown>[] {
	return fixture.messages.map((m, i) => ({
		role: m.role,
		content: [{ type: "text", text: m.content }],
		id: m.id ?? `msg-${i}`,
		timestamp: m.timestamp ?? new Date(Date.now() + i * 1000).toISOString(),
	}));
}

describe("T3: Retrieval", () => {
	// ── Per-fixture retrieval queries ───────────────────────────────────
	for (const fixture of FIXTURES) {
		if (fixture.messages.length === 0 || fixture.queries.length === 0) continue;

		for (const q of fixture.queries) {
			test(`[${fixture.id}] query "${q.query}" finds must-find nodes`, async () => {
				const extracted = await extractFromMessages("test", toAgentMessages(fixture));
				const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 10 });

				for (const mustFind of q.must_find) {
					const found = retrieved.ranked.some((r) =>
						r.node.title.toLowerCase().includes(mustFind.toLowerCase()) ||
						r.node.body.toLowerCase().includes(mustFind.toLowerCase()),
					);
					expect(found, `Query "${q.query}" did not find node containing "${mustFind}"`).toBe(true);
				}
			});

			// Stale memory test
			if (q.should_not_find && q.should_not_find.length > 0) {
				test(`[${fixture.id}] query "${q.query}" does NOT prioritize stale nodes`, async () => {
					const extracted = await extractFromMessages("test", toAgentMessages(fixture));
					const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 10 });

					// Stale nodes can appear but must rank LOWER than must-find nodes
					const mustFindRanks = q.must_find.map((mf) => {
						const idx = retrieved.ranked.findIndex((r) =>
							r.node.title.toLowerCase().includes(mf.toLowerCase()),
						);
						return idx;
					});
					const staleRanks = q.should_not_find!.map((sf) => {
						const idx = retrieved.ranked.findIndex((r) =>
							r.node.title.toLowerCase().includes(sf.toLowerCase()),
						);
						return idx;
					});

					const bestMustFind = Math.min(...mustFindRanks.filter((r) => r >= 0));
					const bestStale = Math.min(...staleRanks.filter((r) => r >= 0));

					if (bestStale >= 0 && bestMustFind >= 0) {
						expect(bestMustFind, `Stale node ranked higher than current: must-find at ${bestMustFind}, stale at ${bestStale}`).toBeLessThan(bestStale);
					}
				});
			}
		}
	}

	// ── Hit@5 benchmark across all query fixtures ───────────────────────
	test("Hit@5 ≥ 95% across all fixtures", async () => {
		let totalQueries = 0;
		let hits = 0;

		for (const fixture of FIXTURES) {
			if (fixture.messages.length === 0 || fixture.queries.length === 0) continue;
			const extracted = await extractFromMessages("test", toAgentMessages(fixture));

			for (const q of fixture.queries) {
				totalQueries++;
				const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 5 });
				const allFound = q.must_find.every((mf) =>
					retrieved.ranked.some((r) =>
						r.node.title.toLowerCase().includes(mf.toLowerCase()) ||
						r.node.body.toLowerCase().includes(mf.toLowerCase()),
					),
				);
				if (allFound) hits++;
			}
		}

		const hitRate = totalQueries > 0 ? hits / totalQueries : 1;
		console.log(`Hit@5: ${hits}/${totalQueries} = ${(hitRate * 100).toFixed(1)}%`);
		expect(hitRate).toBeGreaterThanOrEqual(0.95);
	});

	// ── Indirect recall via neighbor expansion ──────────────────────────
	test("indirect recall: 1-hop expansion finds connected artifacts", async () => {
		// Build a graph: goal → decision → artifact
		const messages = [
			{ role: "user", content: [{ type: "text", text: "目标是减少 memory token 用量" }], id: "u1", timestamp: new Date().toISOString() },
			{ role: "assistant", content: [{ type: "text", text: "方案选择 topology compression。修改了 retrieve.ts" }], id: "a1", timestamp: new Date().toISOString() },
		];
		const extracted = await extractFromMessages("test", messages as Record<string, unknown>[]);

		// Query about the file — should find it directly via IDF
		// But also test: query about "token reduction" should find the decision via goal→decision edge
		const retrieved = retrieveTopology("token reduction strategy", extracted.nodes, extracted.edges, {
			outputLimit: 10,
			expansionHops: 1,
		});

		expect(retrieved.ranked.length).toBeGreaterThan(0);
		// The decision node should appear (either directly or via expansion)
		const hasDecision = retrieved.ranked.some((r) => r.node.kind === "decision");
		expect(hasDecision, "1-hop expansion should surface the decision connected to the goal").toBe(true);
	});
});
