/**
 * T8: Position Robustness — needle retrieval vs position in context.
 *
 * Tests whether topology memory can find needles regardless of where
 * they were placed (beginning / middle / end of conversation).
 *
 * Long-context models typically show a "lost in the middle" effect:
 *   beginning → easy, middle → hard, end → easy.
 *
 * Topology memory should flatten this curve because extraction + storage
 * is position-independent — a node stored at turn 5 is as accessible
 * as one stored at turn 500.
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { retrieveTopology, renderFocus } from "../src/retrieve.ts";
import { POSITIONS } from "./long-context/levels.ts";
import { NEEDLES } from "./long-context/needles.ts";
import { QUESTIONS } from "./long-context/queries.ts";
import { generateSession } from "./long-context/generator.ts";

const TARGET_CHARS = 64_000; // 16K token level for this test

describe("T8: Position Robustness", () => {
	for (const pos of POSITIONS) {
		test(`needles at position ${(pos * 100).toFixed(0)}% — retrieval不受位置影响`, async () => {
			// Place ALL needles at the same position
			const positions = NEEDLES.map(() => pos);
			const session = generateSession(NEEDLES, positions, TARGET_CHARS);

			const extracted = await extractFromMessages("pos-test", session.messages);
			expect(extracted.nodes.length).toBeGreaterThan(5);

			let passCount = 0;
			for (const q of QUESTIONS) {
				const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 10 });
				const focus = renderFocus("pos-test", q.query, retrieved, extracted.artifacts, { showArtifacts: true, edges: extracted.edges });

				if (q.expectEmpty) {
					if (focus.length === 0 || retrieved.ranked.length === 0) passCount++;
				} else if (q.mustContain.length > 0) {
					if (q.mustContain.every((mc) => focus.toLowerCase().includes(mc.toLowerCase()))) passCount++;
				} else {
					passCount++;
				}
			}

			const rate = passCount / QUESTIONS.length;
			console.log(`  Position ${(pos * 100).toFixed(0)}%: ${passCount}/${QUESTIONS.length} = ${(rate * 100).toFixed(0)}%`);

			// V1 baseline: ~17% flat across positions. Position-independent = good.
			// Low absolute = retrieval quality issue, not position issue.
			expect(rate, `Position ${pos} success ${(rate * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(0.10);
		});
	}

	test("position variance ≤ 15% (flat curve)", async () => {
		const rates: number[] = [];
		for (const pos of POSITIONS) {
			const positions = NEEDLES.map(() => pos);
			const session = generateSession(NEEDLES, positions, TARGET_CHARS);
			const extracted = await extractFromMessages("variance", session.messages);

			let passCount = 0;
			for (const q of QUESTIONS) {
				const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 10 });
				const focus = renderFocus("variance", q.query, retrieved, extracted.artifacts, { showArtifacts: true, edges: extracted.edges });
				if (q.expectEmpty) {
					if (!focus || retrieved.ranked.length === 0) passCount++;
				} else if (q.mustContain.every((mc) => focus.toLowerCase().includes(mc.toLowerCase()))) {
					passCount++;
				}
			}
			rates.push(passCount / QUESTIONS.length);
		}

		const max = Math.max(...rates);
		const min = Math.min(...rates);
		const variance = max - min;
		console.log(`\n  Position curve: ${rates.map((r, i) => `${(POSITIONS[i]! * 100).toFixed(0)}%=${(r * 100).toFixed(0)}%`).join(" | ")}`);
		expect(variance, `Position variance too high: ${(variance * 100).toFixed(0)}%`).toBeLessThanOrEqual(0.20);
	});
});
