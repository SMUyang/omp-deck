/**
 * Tests for the canvas add-step palette grouping.
 *
 * Covers the load-bearing invariant: every step-type descriptor in
 * `STEP_TYPE_DESCRIPTIONS` appears in `STEP_CATEGORIES` exactly once. When a
 * new step type lands, the author MUST classify it here — this test fails
 * loudly until they do, instead of the new type silently disappearing from
 * the palette.
 */

import { describe, expect, test } from "bun:test";

import { STEP_TYPE_DESCRIPTIONS } from "../spec-yaml";

import { STEP_CATEGORIES } from "./step-categories";

describe("STEP_CATEGORIES", () => {
	test("category keys are unique", () => {
		const keys = STEP_CATEGORIES.map((c) => c.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("every STEP_TYPE_DESCRIPTIONS entry appears exactly once across categories", () => {
		const seen = new Map<string, number>();
		for (const cat of STEP_CATEGORIES) {
			for (const entry of cat.entries) {
				seen.set(entry.key, (seen.get(entry.key) ?? 0) + 1);
			}
		}
		// Surface duplicates and missing entries with a precise diff.
		const expectedKeys = STEP_TYPE_DESCRIPTIONS.map((d) => d.key).sort();
		const actualKeys = [...seen.keys()].sort();
		expect(actualKeys).toEqual(expectedKeys);
		for (const [key, count] of seen) {
			expect(count, `descriptor "${key}" classified ${count} times`).toBe(1);
		}
	});

	test("no orphan keys reference a missing descriptor", () => {
		const valid = new Set(STEP_TYPE_DESCRIPTIONS.map((d) => d.key));
		for (const cat of STEP_CATEGORIES) {
			for (const entry of cat.entries) {
				expect(valid.has(entry.key), `${cat.key}.${entry.key}`).toBe(true);
			}
		}
	});

	test("at least one category is non-empty", () => {
		expect(STEP_CATEGORIES.some((c) => c.entries.length > 0)).toBe(true);
	});
});
