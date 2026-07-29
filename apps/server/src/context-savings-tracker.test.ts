import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ContextEvidenceTracker } from "./context-evidence-tracker.ts";
import { ContextSavingsTracker } from "./context-savings-tracker.ts";
import { closeDb, getDb, openDb } from "./db/index.ts";

function createManualScheduler(): {
	scheduler: { schedule(callback: () => void, delayMs: number): () => void };
	liveTaskCount(): number;
	executedTaskCount(): number;
	runAll(): void;
} {
	const tasks: Array<{ callback: () => void; cancelled: boolean }> = [];
	let executedTasks = 0;
	return {
		scheduler: {
			schedule(callback) {
				const task = { callback, cancelled: false };
				tasks.push(task);
				return () => {
					task.cancelled = true;
				};
			},
		},
		liveTaskCount() {
			return tasks.filter((task) => !task.cancelled).length;
		},
		executedTaskCount() {
			return executedTasks;
		},
		runAll() {
			for (const task of tasks) {
				if (!task.cancelled) {
					executedTasks += 1;
					task.callback();
				}
			}
		},
	};
}

describe("ContextSavingsTracker without evidence persistence", () => {
	test("remains usable when no database is open", () => {
		closeDb();
		const tracker = new ContextSavingsTracker();
		tracker.recordTriggered("s1", { tokens: 166_435, contextWindow: 1_050_000, percent: 15.85 }, "Preserve this exact focus");

		const stats = tracker.getStats();

		expect(stats.recent[0]?.focus).toBe("Preserve this exact focus");
	});
});

describe("ContextSavingsTracker evidence persistence", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-context-savings-"));

	beforeAll(() => {
		openDb({ path: path.join(tempDir, "test.db") });
	});

	beforeEach(() => {
		getDb().exec("DELETE FROM context_replacement_events");
	});

	afterAll(() => {
		closeDb();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("persists compact_requested evidence with exact focus metadata at trigger", () => {
		const evidence = new ContextEvidenceTracker();
		const tracker = new ContextSavingsTracker(evidence);
		const focus = `Preserve this exact focus ${"x".repeat(260)}`;

		const record = tracker.recordTriggered(
			"s-persist",
			{ tokens: 12_000, contextWindow: 20_000, percent: 60 },
			focus,
		);

		const events = evidence.getSessionEvidence("s-persist");
		expect(events).toHaveLength(1);
		expect(record.evidenceEventId).toBe(events[0]?.id);
		expect(events[0]).toMatchObject({
			status: "compact_requested",
			mechanism: "auto_compact",
			beforeTokens: 12_000,
			beforePercent: 60,
			focusHash: createHash("sha256").update(focus).digest("hex"),
			focusPreview: focus.slice(0, 240),
			focusEstimatedTokens: Math.ceil(focus.length / 4),
		});
	});

	test("updates the exact trigger event when RPC usage drop is observed", () => {
		const evidence = new ContextEvidenceTracker();
		const tracker = new ContextSavingsTracker(evidence);
		const record = tracker.recordTriggered(
			"s-rpc",
			{ tokens: 10_000, contextWindow: 20_000, percent: 50 },
			"same focus",
		);
		const distractorId = evidence.recordReplacement({
			sessionId: "s-rpc",
			status: "compact_requested",
			mechanism: "auto_compact",
			beforeTokens: 10_000,
			beforePercent: 50,
			focusHash: createHash("sha256").update("same focus").digest("hex"),
			focusPreview: "same focus",
			focusEstimatedTokens: 3,
		});

		tracker.maybeCompleteFromRpcUpdate("s-rpc", { tokens: 6_000, contextWindow: 20_000, percent: 30 });

		const events = evidence.getSessionEvidence("s-rpc");
		const updated = events.find((event) => event.id === record.evidenceEventId);
		const distractor = events.find((event) => event.id === distractorId);
		expect(updated).toMatchObject({
			status: "usage_drop_observed",
			afterTokens: 6_000,
			afterPercent: 30,
			savedTokens: 4_000,
			savedPercent: 40,
		});
		expect(distractor?.status).toBe("compact_requested");
	});

	test("records compact completion without claiming an unobserved usage drop", () => {
		const evidence = new ContextEvidenceTracker();
		const tracker = new ContextSavingsTracker(evidence);
		const record = tracker.recordTriggered(
			"s-no-drop",
			{ tokens: 5_000, contextWindow: 10_000, percent: 50 },
			"focus",
		);

		tracker.recordCompleted("s-no-drop", { tokens: 5_000, contextWindow: 10_000, percent: 50 });

		const event = evidence.getSessionEvidence("s-no-drop").find((candidate) => candidate.id === record.evidenceEventId);
		expect(event).toMatchObject({
			status: "compact_completed",
			afterTokens: 5_000,
			afterPercent: 50,
			savedTokens: 0,
			savedPercent: 0,
		});
	});

	test("records compact completion with unknown after usage as null evidence", () => {
		const evidence = new ContextEvidenceTracker();
		const tracker = new ContextSavingsTracker(evidence);
		const record = tracker.recordTriggered(
			"s-unknown-after",
			{ tokens: 5_000, contextWindow: 10_000, percent: 50 },
			"focus",
		);

		tracker.recordCompleted("s-unknown-after");

		const event = evidence.getSessionEvidence("s-unknown-after").find((candidate) => candidate.id === record.evidenceEventId);
		expect(event).toMatchObject({
			status: "compact_completed",
			afterTokens: null,
			afterPercent: null,
			savedTokens: null,
			savedPercent: null,
		});
	});

	test("marks the exact event timed out when no usage update ever arrives", () => {
		const evidence = new ContextEvidenceTracker();
		const { scheduler, runAll } = createManualScheduler();
		const tracker = new ContextSavingsTracker(evidence, scheduler);
		const record = tracker.recordTriggered(
			"s-timeout",
			{ tokens: 8_000, contextWindow: 10_000, percent: 80 },
			"focus",
		);
		const distractorId = evidence.recordReplacement({
			sessionId: "s-timeout",
			status: "compact_requested",
			mechanism: "auto_compact",
			focusHash: "distractor-timeout",
			focusPreview: "distractor-timeout",
		});

		runAll();

		const events = evidence.getSessionEvidence("s-timeout");
		const timedOut = events.find((event) => event.id === record.evidenceEventId);
		const distractor = events.find((event) => event.id === distractorId);
		expect(timedOut).toMatchObject({
			status: "awaiting_usage",
			errorMessage: expect.stringContaining("awaiting post-replace usage update"),
		});
		expect(distractor?.status).toBe("compact_requested");
	});

	test("cancels the previous timeout when the same session triggers again", () => {
		const evidence = new ContextEvidenceTracker();
		const { scheduler, liveTaskCount, executedTaskCount, runAll } = createManualScheduler();
		const tracker = new ContextSavingsTracker(evidence, scheduler);

		tracker.recordTriggered("s-retrigger", { tokens: 8_000, contextWindow: 10_000, percent: 80 }, "first");
		tracker.recordTriggered("s-retrigger", { tokens: 9_000, contextWindow: 10_000, percent: 90 }, "second");

		expect(liveTaskCount()).toBe(1);
		runAll();
		expect(executedTaskCount()).toBe(1);
	});

	test("clears the timeout so a late callback cannot overwrite completion", () => {
		const evidence = new ContextEvidenceTracker();
		const { scheduler, runAll } = createManualScheduler();
		const tracker = new ContextSavingsTracker(evidence, scheduler);
		const record = tracker.recordTriggered(
			"s-late-timeout",
			{ tokens: 8_000, contextWindow: 10_000, percent: 80 },
			"focus",
		);

		tracker.recordCompleted("s-late-timeout", { tokens: 2_000, contextWindow: 10_000, percent: 20 });
		runAll();

		const event = evidence.getSessionEvidence("s-late-timeout").find((candidate) => candidate.id === record.evidenceEventId);
		expect(event?.status).toBe("compact_completed");
	});

	test("marks the exact pending event failed and prevents later completion or timeout", () => {
		const evidence = new ContextEvidenceTracker();
		const { scheduler, runAll } = createManualScheduler();
		const tracker = new ContextSavingsTracker(evidence, scheduler);
		const record = tracker.recordTriggered(
			"s-failed",
			{ tokens: 8_000, contextWindow: 10_000, percent: 80 },
			"focus",
		);
		const distractorId = evidence.recordReplacement({
			sessionId: "s-failed",
			status: "compact_requested",
			mechanism: "auto_compact",
			focusHash: "distractor",
			focusPreview: "distractor",
		});

		tracker.recordFailed("s-failed", new Error("compact transport failed"));
		runAll();
		const completed = tracker.maybeCompleteFromRpcUpdate("s-failed", { tokens: 1_000, contextWindow: 10_000, percent: 10 });

		const events = evidence.getSessionEvidence("s-failed");
		const failed = events.find((event) => event.id === record.evidenceEventId);
		const distractor = events.find((event) => event.id === distractorId);
		expect(completed).toBeUndefined();
		expect(failed).toMatchObject({ status: "failed", errorMessage: "compact transport failed" });
		expect(distractor?.status).toBe("compact_requested");
	});

	test("backfills the awaiting_usage event once a usage drop arrives late", () => {
		const evidence = new ContextEvidenceTracker();
		const { scheduler, runAll } = createManualScheduler();
		const tracker = new ContextSavingsTracker(evidence, scheduler);
		const record = tracker.recordTriggered(
			"s-late-backfill",
			{ tokens: 8_000, contextWindow: 10_000, percent: 80 },
			"focus",
		);
		runAll();
		// First event is now `awaiting_usage` and still pending.
		expect(tracker.hasPending("s-late-backfill")).toBe(true);
		const lateUsage = { tokens: 3_000, contextWindow: 10_000, percent: 30 };
		const completed = tracker.completePendingFromUsage("s-late-backfill", lateUsage);
		expect(completed).toBeDefined();
		expect(completed?.after).toEqual({ tokens: 3_000, percent: 30 });
		expect(completed?.afterStatus).toBe("populated");
		expect(tracker.hasPending("s-late-backfill")).toBe(false);
		const events = evidence.getSessionEvidence("s-late-backfill");
		const event = events.find((e) => e.id === record.evidenceEventId);
		expect(event).toMatchObject({
			status: "usage_drop_observed",
			afterTokens: 3_000,
			savedTokens: 5_000,
			savedPercent: 62.5,
		});
	});

	test("completePendingFromUsage stays in awaiting_usage when drop is below threshold", () => {
		const evidence = new ContextEvidenceTracker();
		const { scheduler, runAll } = createManualScheduler();
		const tracker = new ContextSavingsTracker(evidence, scheduler);
		const record = tracker.recordTriggered(
			"s-stale-usage",
			{ tokens: 8_000, contextWindow: 10_000, percent: 80 },
			"focus",
		);
		runAll();
		// Usage update arrives but is essentially the same as before (stale).
		const completed = tracker.completePendingFromUsage(
			"s-stale-usage",
			{ tokens: 7_990, contextWindow: 10_000, percent: 79.9 },
		);
		expect(completed).toBeUndefined();
		expect(tracker.hasPending("s-stale-usage")).toBe(true);
		const events = evidence.getSessionEvidence("s-stale-usage");
		const event = events.find((e) => e.id === record.evidenceEventId);
		expect(event?.status as string | undefined).toBe("awaiting_usage");
	});
});
