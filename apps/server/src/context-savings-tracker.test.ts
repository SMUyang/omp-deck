import { describe, expect, test } from "bun:test";

import { ContextSavingsTracker } from "./context-savings-tracker.ts";

describe("ContextSavingsTracker", () => {
	test("includes the compact focus text in recent replacement records", () => {
		const tracker = new ContextSavingsTracker();
		tracker.recordTriggered("s1", { tokens: 166_435, contextWindow: 1_050_000, percent: 15.85 }, "Preserve this exact focus");

		const stats = tracker.getStats();

		expect(stats.recent[0]?.focus).toBe("Preserve this exact focus");
	});
});
