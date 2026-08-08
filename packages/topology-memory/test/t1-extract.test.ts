/**
 * T1: Node Extraction — classification stability + precision/recall
 *
 * Tests:
 *   - Each golden fixture produces expected nodes
 *   - Kind accuracy across all fixtures
 *   - Adversarial classification cases (negation, false triggers)
 *   - Precision/Recall metrics
 */

import { test, expect, describe } from "bun:test";
import { extractFromMessages } from "../src/extract.ts";
import { FIXTURES, ADVERSARIAL_CLASSIFICATIONS } from "./golden/fixtures.ts";
import type { GoldenFixture, ExpectedNode } from "./golden/fixtures.ts";
import type { TopologyNode } from "../src/types.ts";

function toAgentMessages(fixture: GoldenFixture): Record<string, unknown>[] {
	return fixture.messages.map((m, i) => ({
		role: m.role,
		content: [{ type: "text", text: m.content }],
		id: m.id ?? `msg-${i}`,
		timestamp: m.timestamp ?? new Date(Date.now() + i * 1000).toISOString(),
	}));
}

function findNode(nodes: TopologyNode[], expected: ExpectedNode): TopologyNode | undefined {
	return nodes.find((n) =>
		n.kind === expected.kind &&
		(n.title.toLowerCase().includes(expected.title_contains.toLowerCase()) ||
		 n.body.toLowerCase().includes(expected.title_contains.toLowerCase())),
	);
}

describe("T1: Node Extraction", () => {
	// ── Per-fixture extraction tests ────────────────────────────────────
	for (const fixture of FIXTURES) {
		if (fixture.messages.length === 0) continue; // skip programmatic fixtures

		test(`[${fixture.id}] ${fixture.description}`, async () => {
			const result = await extractFromMessages("test", toAgentMessages(fixture));

			for (const expected of fixture.expected_nodes) {
				const found = findNode(result.nodes, expected);
				expect(found, `Expected node [${expected.kind}] containing "${expected.title_contains}"`).toBeDefined();
				if (expected.min_importance !== undefined && found) {
					expect(found.importance).toBeGreaterThanOrEqual(expected.min_importance);
				}
			}
		});
	}

	// ── Kind accuracy metrics ───────────────────────────────────────────
	test("kind accuracy across all fixtures ≥ 90%", async () => {
		let totalExpected = 0;
		let correct = 0;

		for (const fixture of FIXTURES) {
			if (fixture.messages.length === 0) continue;
			const result = await extractFromMessages("test", toAgentMessages(fixture));
			for (const expected of fixture.expected_nodes) {
				totalExpected++;
				if (findNode(result.nodes, expected)) correct++;
			}
		}

		const accuracy = totalExpected > 0 ? correct / totalExpected : 1;
		console.log(`Kind accuracy: ${correct}/${totalExpected} = ${(accuracy * 100).toFixed(1)}%`);
		expect(accuracy).toBeGreaterThanOrEqual(0.90);
	});

	// ── Critical recall (goal, constraint, decision, issue, resolution) ─
	test("critical node recall ≥ 95%", async () => {
		const criticalKinds = new Set(["goal", "constraint", "decision", "issue", "resolution"]);
		let criticalExpected = 0;
		let criticalFound = 0;

		for (const fixture of FIXTURES) {
			if (fixture.messages.length === 0) continue;
			const result = await extractFromMessages("test", toAgentMessages(fixture));
			for (const expected of fixture.expected_nodes) {
				if (!criticalKinds.has(expected.kind)) continue;
				criticalExpected++;
				if (findNode(result.nodes, expected)) criticalFound++;
			}
		}

		const recall = criticalExpected > 0 ? criticalFound / criticalExpected : 1;
		console.log(`Critical recall: ${criticalFound}/${criticalExpected} = ${(recall * 100).toFixed(1)}%`);
		expect(recall).toBeGreaterThanOrEqual(0.95);
	});

	// ── Adversarial classification ──────────────────────────────────────
	describe("adversarial classification", () => {
		for (const tc of ADVERSARIAL_CLASSIFICATIONS) {
			test(`"${tc.text.slice(0, 40)}..." → ${tc.expected} (${tc.why})`, async () => {
				const messages = [{
					role: tc.role,
					content: [{ type: "text", text: tc.text }],
					id: "adv-1",
					timestamp: new Date().toISOString(),
				}];
				const result = await extractFromMessages("adv", messages as Record<string, unknown>[]);

				if (tc.expected === "skip") {
					expect(result.nodes.length).toBe(0);
				} else {
					expect(result.nodes.length).toBe(1);
					expect(result.nodes[0]!.kind).toBe(tc.expected);
				}
			});
		}
	});
});
