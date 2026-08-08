/**
 * T6: Long-Context Retrieval Benchmark
 *
 * Tests whether topology memory can retrieve needle memories
 * at increasing context lengths (8K → 256K tokens).
 *
 * Uses Layer A (retrieval-only, no LLM): generate sessions with
 * needles + distractors → extract → retrieve → check if needles found.
 *
 * Metrics: Recall@1, Recall@5, per-question-type success rate,
 * degradation curve across context levels.
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { retrieveTopology, renderFocus } from "../src/retrieve.ts";
import { LEVELS, V2_TARGETS } from "./long-context/levels.ts";
import { NEEDLES } from "./long-context/needles.ts";
import { QUESTIONS } from "./long-context/queries.ts";
import { generateSession } from "./long-context/generator.ts";

// Run only levels that are practical for unit testing (limit to 3 levels for speed)
const TEST_LEVELS = LEVELS.slice(0, 3); // 8K, 16K, 32K

describe("T6: Long-Context Retrieval Scaling", () => {
	for (const level of TEST_LEVELS) {
		test(`[${level.id} ${level.label}] needle extraction + retrieval`, async () => {
			// Generate session with needles at evenly distributed positions
			const positions = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 0.1, 0.9];
			const session = generateSession(NEEDLES, positions, level.approxChars);

			// Extract topology
			const extracted = await extractFromMessages("benchmark", session.messages);
			expect(extracted.nodes.length, `Should extract meaningful nodes`).toBeGreaterThan(5);

			// Test each question
			let passCount = 0;
			const results: string[] = [];

			for (const q of QUESTIONS) {
				const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 10 });
				const focus = renderFocus("benchmark", q.query, retrieved, extracted.artifacts, { showArtifacts: true, edges: extracted.edges });
				const focusLower = focus.toLowerCase();

				let passed = false;
				if (q.expectEmpty) {
					passed = focus.length === 0 || retrieved.ranked.length === 0;
				} else if (q.mustContain.length > 0) {
					passed = q.mustContain.every((mc) => focusLower.includes(mc.toLowerCase()));
				} else {
					passed = true;
				}

				if (passed) passCount++;
				results.push(`  ${passed ? "✓" : "✗"} [${q.type}] ${q.query.slice(0, 30)}`);
		}

		const successRate = passCount / QUESTIONS.length;
		console.log(`\n[${level.id} ${level.label}] ${passCount}/${QUESTIONS.length} = ${(successRate * 100).toFixed(0)}%`);
		console.log(results.join("\n"));

		// V1 baseline measurement: flat ~58% across levels (no degradation = good)
		// V2 target: ≥88% at 128K. Current test documents the baseline.
		expect(successRate, `${level.id} success too low`).toBeGreaterThanOrEqual(0.40);
		});
	}
});
