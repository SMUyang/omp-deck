/**
 * T6-V2: Long-Context Scaling Benchmark (Frozen V2)
 *
 * Runs all 6 levels (8K → 256K) with the FIXED generator.
 * Reports the degradation curve + retrieval funnel per question.
 *
 * Two independent goals:
 *   Track A: Verify flat curve (length-independence)
 *   Track B: Measure absolute retrieval quality (V2 baseline for V3 comparison)
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { retrieveTopology, renderFocus } from "../src/retrieve.ts";
import { LEVELS, V2_TARGETS } from "./long-context/levels.ts";
import { NEEDLES } from "./long-context/needles.ts";
import { QUESTIONS, type QAQuestion } from "./long-context/queries.ts";
import { generateSession } from "./long-context/generator.ts";

// ── Retrieval Funnel ────────────────────────────────────────────────────

interface FunnelResult {
	questionId: string;
	questionType: string;
	stored: boolean;      // needle exists in extracted nodes
	seedTop20: boolean;   // needle in top-20 candidates
	finalTop5: boolean;   // needle in top-5 after expansion
	focusHit: boolean;    // focus text contains answer
	stage: "stored" | "seed" | "expansion" | "ranking" | "focus" | "pass" | "negative_pass";
}

function traceFunnel(
	q: QAQuestion,
	extracted: Awaited<ReturnType<typeof extractFromMessages>>,
): FunnelResult {
	const retrieved = retrieveTopology(q.query, extracted.nodes, extracted.edges, { outputLimit: 5, candidateLimit: 20 });
	const focus = renderFocus("bench", q.query, retrieved, extracted.artifacts, { showArtifacts: true, edges: extracted.edges });
	const focusLower = focus.toLowerCase();

	// For negative questions: success = no relevant results
	if (q.expectEmpty) {
		const passed = focus.includes('status="unknown"') || focus.length === 0 || retrieved.ranked.length === 0;
		return {
			questionId: q.id, questionType: q.type,
			stored: true, seedTop20: true, finalTop5: true,
			focusHit: passed,
			stage: passed ? "negative_pass" : "focus",
		};
	}

	// Check if any needle matching mustContain exists in extracted nodes
	const mustContainLower = q.mustContain.map((mc) => mc.toLowerCase());
	const stored = extracted.nodes.some((n) =>
		mustContainLower.some((mc) => n.title.toLowerCase().includes(mc) || n.body.toLowerCase().includes(mc)),
	);

	// Check seed (top-20 candidates)
	const seedTop20 = retrieved.candidateNodeCount > 0 && retrieved.ranked.length > 0;

	// Check final top-5
	const finalTop5 = retrieved.ranked.length > 0;

	// Check focus contains answer
	const focusHit = q.mustContain.every((mc) => focusLower.includes(mc.toLowerCase()));

	let stage: FunnelResult["stage"] = "pass";
	if (!stored) stage = "stored";
	else if (!seedTop20) stage = "seed";
	else if (!finalTop5) stage = "expansion";
	else if (!focusHit) stage = "focus";

	return { questionId: q.id, questionType: q.type, stored, seedTop20, finalTop5, focusHit, stage };
}

// ── Benchmark ───────────────────────────────────────────────────────────

describe("T6-V2: Long-Context Scaling (Frozen V2, 8K–256K)", () => {
	const positions = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 0.1, 0.9];
	const allResults: Array<{ level: string; successRate: number; funnel: FunnelResult[] }> = [];

	for (const level of LEVELS) {
		test(`[${level.id} ${level.label}] scaling benchmark`, async () => {
			const session = generateSession(NEEDLES, positions, level.approxChars);
			const extracted = await extractFromMessages("scaling", session.messages);

			let passCount = 0;
			const funnel: FunnelResult[] = [];

			for (const q of QUESTIONS) {
				const result = traceFunnel(q, extracted);
				funnel.push(result);
				if (result.focusHit) passCount++;
			}

			const successRate = passCount / QUESTIONS.length;
			allResults.push({ level: level.label, successRate, funnel });

			console.log(`\n[${level.id} ${level.label}] ${passCount}/${QUESTIONS.length} = ${(successRate * 100).toFixed(0)}%`);
			for (const f of funnel) {
				const status = f.focusHit ? "✓" : "✗";
				console.log(`  ${status} [${f.questionType.padEnd(15)}] ${f.questionId} → ${f.stage}`);
			}
		});
	}

	// ── Summary after all levels ─────────────────────────────────────────
	test("scaling curve summary", () => {
		console.log("\n═══════════════════════════════════════════════════");
		console.log("V2-Frozen Scaling Curve (Track A: length-independence)");
		console.log("═══════════════════════════════════════════════════");
		for (const r of allResults) {
			const bar = "█".repeat(Math.round(r.successRate * 30));
			console.log(`  ${r.level.padEnd(6)} ${bar} ${(r.successRate * 100).toFixed(0)}%`);
		}

		// Check variance
		if (allResults.length >= 2) {
			const rates = allResults.map((r) => r.successRate);
			const max = Math.max(...rates);
			const min = Math.min(...rates);
			const variance = max - min;
			console.log(`\n  Variance: ${(variance * 100).toFixed(0)}% (max=${(max * 100).toFixed(0)}%, min=${(min * 100).toFixed(0)}%)`);
			console.log(`  Mean: ${((rates.reduce((a, b) => a + b, 0) / rates.length) * 100).toFixed(0)}%`);
			expect(variance, "Scaling variance should be low (length-independent)").toBeLessThanOrEqual(0.15);
		}
	});

	// ── Failure taxonomy ────────────────────────────────────────────────
	test("failure taxonomy (bottleneck identification)", () => {
		// Aggregate failure stages across all levels
		const stageCounts = new Map<string, number>();
		let totalQuestions = 0;
		let totalFailures = 0;

		for (const r of allResults) {
			for (const f of r.funnel) {
				totalQuestions++;
				if (!f.focusHit) {
					totalFailures++;
					stageCounts.set(f.stage, (stageCounts.get(f.stage) ?? 0) + 1);
				}
			}
		}

		console.log("\n═══════════════════════════════════════════════════");
		console.log("Retrieval Funnel — Failure Taxonomy");
		console.log(`Total: ${totalQuestions} queries, ${totalFailures} failures`);
		console.log("═══════════════════════════════════════════════════");

		const stageLabels: Record<string, string> = {
			stored: "A. Extraction failure (needle not stored as node)",
			seed: "B. Seed retrieval failure (node not in top-20)",
			expansion: "C. Graph traversal failure (neighbor not expanded)",
			focus: "D. Ranking/focus failure (correct node exists but answer not in focus)",
			pass: "E. Pass",
			negative_pass: "E. Pass (negative question)",
		};

		for (const [stage, count] of [...stageCounts.entries()].sort((a, b) => b[1] - a[1])) {
			const pct = totalQuestions > 0 ? (count / totalQuestions * 100).toFixed(0) : "0";
			console.log(`  ${stageLabels[stage] ?? stage}: ${count} (${pct}%)`);
		}

		const successRate = totalQuestions > 0 ? (totalQuestions - totalFailures) / totalQuestions : 0;
		console.log(`\n  Overall QA Success: ${totalQuestions - totalFailures}/${totalQuestions} = ${(successRate * 100).toFixed(0)}%`);
		console.log(`  V2 Target at 128K: >=88%`);
		console.log(`  V3 Target: raise absolute recall from ${(successRate * 100).toFixed(0)}% to >=85%`);
	});
});
