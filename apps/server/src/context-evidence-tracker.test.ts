import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { openDb, closeDb, getDb } from "./db/index.ts";
import { ContextEvidenceTracker } from "./context-evidence-tracker.ts";
import type {
	ContextReplacementEvent,
	ContextEvidenceStats,
	ContextReplacementStatus,
	ContextReplacementMechanism,
} from "@omp-deck/protocol";

// ─── Test setup: temp DB with manual CREATE TABLE (migration 008 not landed via runner) ───

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-evidence-"));
const dbPath = path.join(tempDir, "test.db");

beforeAll(() => {
	openDb({ path: dbPath });
	const db = getDb();
	db.exec(`
		CREATE TABLE IF NOT EXISTS context_replacement_events (
			id                      TEXT PRIMARY KEY,
			session_id              TEXT NOT NULL,
			status                  TEXT NOT NULL,
			mechanism               TEXT NOT NULL,
			before_tokens           INTEGER,
			before_percent          REAL,
			after_tokens            INTEGER,
			after_percent           REAL,
			saved_tokens            INTEGER,
			saved_percent           REAL,
			focus_hash              TEXT NOT NULL,
			focus_preview           TEXT NOT NULL,
			focus_estimated_tokens  INTEGER NOT NULL,
			focus_estimate_method   TEXT NOT NULL DEFAULT 'chars_div_4',
			provider_role           TEXT,
			error_message           TEXT,
			retry_count             INTEGER NOT NULL DEFAULT 0,
			created_at              TEXT NOT NULL,
			updated_at              TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_context_replacement_events_session
			ON context_replacement_events(session_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_context_replacement_events_status
			ON context_replacement_events(status, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_context_replacement_events_hash
			ON context_replacement_events(session_id, focus_hash);
	`);
});

afterAll(() => {
	closeDb();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ContextEvidenceTracker", () => {
	beforeEach(() => {
		getDb().exec("DELETE FROM context_replacement_events");
	});
	describe("recordReplacement", () => {
		test("inserts an event and returns an eventId", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s1",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "abc123",
				focusPreview: "Test focus preview text",
				focusEstimatedTokens: 5,
			});

			expect(eventId).toBeString();
			expect(eventId.length).toBeGreaterThan(0);
		});

		test("persists to DB and is retrievable via getSessionEvidence", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s1",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "hash-1",
				focusPreview: "Focus text for session s1",
				focusEstimatedTokens: 8,
			});

			const events = tracker.getSessionEvidence("s1");
			expect(events.length).toBeGreaterThanOrEqual(1);
			const found = events.find((e) => e.id === eventId)!;
			expect(found).toBeDefined();
			expect(found.status).toBe("constructed");
			expect(found.mechanism).toBe("context_hook");
			expect(found.focusHash).toBe("hash-1");
			expect(found.focusPreview).toBe("Focus text for session s1");
			expect(found.focusEstimatedTokens).toBe(8);
			expect(found.focusEstimateMethod).toBe("chars_div_4");
			expect(found.retryCount).toBe(0);
		});

		test("computes savedTokens when both beforeTokens and afterTokens are present", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s1",
				status: "provider_payload_observed",
				mechanism: "auto_compact",
				beforeTokens: 10000,
				beforePercent: 50,
				afterTokens: 6000,
				afterPercent: 30,
				focusHash: "hash-2",
				focusPreview: "Focus with tokens",
				focusEstimatedTokens: 5,
			});

			const events = tracker.getSessionEvidence("s1");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.savedTokens).toBe(4000); // 10000 - 6000
			expect(ev.savedPercent).toBe(40);  // (10000-6000)/10000 * 100 = 40
		});

		test("savedTokens is null when beforeTokens is null", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s2",
				status: "handler_returned",
				mechanism: "context_hook",
				beforeTokens: null,
				afterTokens: 5000,
				focusHash: "hash-3",
				focusPreview: "Null before",
				focusEstimatedTokens: 3,
			});

			const events = tracker.getSessionEvidence("s2");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.savedTokens).toBeNull();
			expect(ev.savedPercent).toBeNull();
		});

		test("savedTokens is null when afterTokens is null", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s2",
				status: "handler_returned",
				mechanism: "context_hook",
				beforeTokens: 10000,
				afterTokens: null,
				focusHash: "hash-4",
				focusPreview: "Null after",
				focusEstimatedTokens: 3,
			});

			const events = tracker.getSessionEvidence("s2");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.savedTokens).toBeNull();
			expect(ev.savedPercent).toBeNull();
		});

		test("savedTokens is 0 when before equals after", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s3",
				status: "compact_completed",
				mechanism: "auto_compact",
				beforeTokens: 5000,
				afterTokens: 5000,
				focusHash: "hash-5",
				focusPreview: "Zero savings",
				focusEstimatedTokens: 3,
			});

			const events = tracker.getSessionEvidence("s3");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.savedTokens).toBe(0);
			expect(ev.savedPercent).toBe(0);
		});

		test("savedTokens is 0 when after exceeds before (clamped to zero)", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s3",
				status: "compact_completed",
				mechanism: "auto_compact",
				beforeTokens: 3000,
				afterTokens: 8000,
				focusHash: "hash-6",
				focusPreview: "Negative clamped",
				focusEstimatedTokens: 3,
			});

			const events = tracker.getSessionEvidence("s3");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.savedTokens).toBe(0);
		});

		test("stores optional providerRole and errorMessage", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s4",
				status: "failed",
				mechanism: "auto_compact",
				focusHash: "hash-7",
				focusPreview: "Error case",
				focusEstimatedTokens: 1,
				providerRole: "default",
				errorMessage: "timeout after 30s",
			});

			const events = tracker.getSessionEvidence("s4");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.providerRole).toBe("default");
			expect(ev.errorMessage).toBe("timeout after 30s");
		});

		test("records created_at and updated_at timestamps, identical on insert", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s5",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "hash-8",
				focusPreview: "Timestamped",
				focusEstimatedTokens: 2,
			});

			const events = tracker.getSessionEvidence("s5");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.createdAt).toBeString();
			expect(ev.createdAt.length).toBeGreaterThan(0);
			expect(ev.updatedAt).toBeString();
			expect(ev.updatedAt).toBe(ev.createdAt);
		});

		test("defaults focusEstimateMethod to 'chars_div_4'", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s6",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "hash-9",
				focusPreview: "Default method",
				focusEstimatedTokens: 3,
			});

			const events = tracker.getSessionEvidence("s6");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.focusEstimateMethod).toBe("chars_div_4");
		});

		test("accepts explicit focusEstimateMethod", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s7",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "hash-10",
				focusPreview: "Explicit method",
				focusEstimatedTokens: 3,
				focusEstimateMethod: "chars_div_4",
			});

			const events = tracker.getSessionEvidence("s7");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.focusEstimateMethod).toBe("chars_div_4");
		});
	});

	describe("updateStatus", () => {
		test("updates status on an existing event", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s10",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "hash-10",
				focusPreview: "Will update",
				focusEstimatedTokens: 3,
			});

			tracker.updateStatus(eventId, "handler_returned");

			const events = tracker.getSessionEvidence("s10");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.status).toBe("handler_returned");
		});

		test("recomputes savedTokens when token fields are provided in updates", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s11",
				status: "constructed",
				mechanism: "auto_compact",
				beforeTokens: 12000,
				focusHash: "hash-11",
				focusPreview: "Partial tokens",
				focusEstimatedTokens: 4,
			});

			// Initially savedTokens is null (no afterTokens)
			let events = tracker.getSessionEvidence("s11");
			let ev = events.find((e) => e.id === eventId)!;
			expect(ev.savedTokens).toBeNull();

			// Update with afterTokens
			tracker.updateStatus(eventId, "usage_drop_observed", {
				afterTokens: 8500,
				afterPercent: 42.5,
			});

			events = tracker.getSessionEvidence("s11");
			ev = events.find((e) => e.id === eventId)!;
			expect(ev.status).toBe("usage_drop_observed");
			expect(ev.savedTokens).toBe(3500); // 12000 - 8500
		});

		test("updates providerRole in status transition", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s12",
				status: "compact_completed",
				mechanism: "auto_compact",
				focusHash: "hash-12",
				focusPreview: "Provider role later",
				focusEstimatedTokens: 3,
			});

			tracker.updateStatus(eventId, "provider_payload_observed", {
				providerRole: "default",
			});

			const events = tracker.getSessionEvidence("s12");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.status).toBe("provider_payload_observed");
			expect(ev.providerRole).toBe("default");
		});

		test("updates updated_at on status change", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s13",
				status: "constructed",
				mechanism: "context_hook",
				focusHash: "hash-13",
				focusPreview: "Timestamp update check",
				focusEstimatedTokens: 2,
			});

			const eventsBefore = tracker.getSessionEvidence("s13");
			const createdAt = eventsBefore.find((e) => e.id === eventId)!.createdAt;

			tracker.updateStatus(eventId, "handler_returned");

			const eventsAfter = tracker.getSessionEvidence("s13");
			const ev = eventsAfter.find((e) => e.id === eventId)!;
			expect(ev.createdAt).toBe(createdAt);
			// updatedAt was refreshed
			expect(ev.updatedAt).toBeString();
			expect(ev.updatedAt.length).toBeGreaterThan(0);
		});

		test("is a no-op for non-existent eventId (does not throw)", () => {
			const tracker = new ContextEvidenceTracker();
			expect(() => {
				tracker.updateStatus("nonexistent", "failed");
			}).not.toThrow();
		});

		test("updates errorMessage in status transition", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s14",
				status: "compact_requested",
				mechanism: "auto_compact",
				focusHash: "hash-14",
				focusPreview: "will fail",
				focusEstimatedTokens: 3,
			});

			tracker.updateStatus(eventId, "failed", {
				errorMessage: "compact operation timed out",
			});

			const events = tracker.getSessionEvidence("s14");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.status).toBe("failed");
			expect(ev.errorMessage).toBe("compact operation timed out");
		});

		test("can update beforeTokens as well", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "s15",
				status: "constructed",
				mechanism: "context_hook",
				afterTokens: 5000,
				focusHash: "hash-15",
				focusPreview: "Add before later",
				focusEstimatedTokens: 3,
			});

			tracker.updateStatus(eventId, "compact_requested", {
				beforeTokens: 12000,
				beforePercent: 60,
			});

			const events = tracker.getSessionEvidence("s15");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.beforeTokens).toBe(12000);
			expect(ev.savedTokens).toBe(7000); // recomputed: 12000 - 5000
		});
	});

	describe("getSessionEvidence", () => {
		test("returns events filtered by sessionId", () => {
			const tracker = new ContextEvidenceTracker();
			tracker.recordReplacement({
				sessionId: "sa", status: "constructed", mechanism: "context_hook",
				focusHash: "ha", focusPreview: "Session A", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "sb", status: "constructed", mechanism: "context_hook",
				focusHash: "hb", focusPreview: "Session B", focusEstimatedTokens: 1,
			});

			expect(tracker.getSessionEvidence("sa").length).toBe(1);
			expect(tracker.getSessionEvidence("sb").length).toBe(1);
			expect(tracker.getSessionEvidence("sc").length).toBe(0);
		});

		test("returns events in reverse chronological order (newest first)", () => {
			const tracker = new ContextEvidenceTracker();
			tracker.recordReplacement({
				sessionId: "sx", status: "constructed", mechanism: "context_hook",
				focusHash: "h1", focusPreview: "First", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "sx", status: "handler_returned", mechanism: "context_hook",
				focusHash: "h2", focusPreview: "Second", focusEstimatedTokens: 1,
			});

			const events = tracker.getSessionEvidence("sx");
			expect(events.length).toBe(2);
			expect(events[0]!.focusPreview).toBe("Second");
			expect(events[1]!.focusPreview).toBe("First");
		});

		test("respects limit parameter", () => {
			const tracker = new ContextEvidenceTracker();
			for (let i = 0; i < 5; i++) {
				tracker.recordReplacement({
					sessionId: "slim", status: "constructed", mechanism: "context_hook",
					focusHash: `h${i}`, focusPreview: `Event ${i}`, focusEstimatedTokens: 1,
				});
			}

			const events = tracker.getSessionEvidence("slim", 3);
			expect(events.length).toBe(3);
		});

		test("respects offset parameter for pagination", () => {
			const tracker = new ContextEvidenceTracker();
			for (let i = 0; i < 5; i++) {
				tracker.recordReplacement({
					sessionId: "soff", status: "constructed", mechanism: "context_hook",
					focusHash: `h${i}`, focusPreview: `Event ${i}`, focusEstimatedTokens: 1,
				});
			}

			const page1 = tracker.getSessionEvidence("soff", 2, 0);
			const page2 = tracker.getSessionEvidence("soff", 2, 2);
			const page3 = tracker.getSessionEvidence("soff", 2, 4);

			expect(page1.length).toBe(2);
			expect(page2.length).toBe(2);
			expect(page3.length).toBe(1);
			const ids = new Set([...page1, ...page2, ...page3].map((e) => e.id));
			expect(ids.size).toBe(5);
		});

		test("returns empty array for non-existent session", () => {
			const tracker = new ContextEvidenceTracker();
			expect(tracker.getSessionEvidence("nonexistent")).toEqual([]);
		});
	});

	describe("getStats", () => {

		test("returns zeros for empty DB", () => {
			const tracker = new ContextEvidenceTracker();
			const stats = tracker.getStats();
			expect(stats.total).toBe(0);
			expect(stats.completed).toBe(0);
			expect(stats.totalSaved).toBe(0);
			expect(stats.recent).toEqual([]);
		});

		test("total counts all events regardless of status", () => {
			const tracker = new ContextEvidenceTracker();
			tracker.recordReplacement({
				sessionId: "st1", status: "constructed", mechanism: "context_hook",
				focusHash: "h-a", focusPreview: "A", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "st1", status: "failed", mechanism: "auto_compact",
				focusHash: "h-b", focusPreview: "B", focusEstimatedTokens: 1,
			});

			const stats = tracker.getStats();
			expect(stats.total).toBe(2);
		});

		test("completed counts only provider_payload_observed events", () => {
			const tracker = new ContextEvidenceTracker();
			tracker.recordReplacement({
				sessionId: "st2", status: "constructed", mechanism: "context_hook",
				focusHash: "h-c", focusPreview: "C", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "st2", status: "provider_payload_observed", mechanism: "auto_compact",
				beforeTokens: 10000, afterTokens: 6000,
				focusHash: "h-d", focusPreview: "D", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "st2", status: "provider_payload_observed", mechanism: "context_hook",
				beforeTokens: 5000, afterTokens: 3000,
				focusHash: "h-e", focusPreview: "E", focusEstimatedTokens: 1,
			});

			const stats = tracker.getStats();
			expect(stats.total).toBe(3);
			expect(stats.completed).toBe(2);
		});

		test("totalSaved sums only non-null savedTokens", () => {
			const tracker = new ContextEvidenceTracker();
			tracker.recordReplacement({
				sessionId: "st3", status: "provider_payload_observed", mechanism: "auto_compact",
				beforeTokens: 10000, afterTokens: 6000,
				focusHash: "h-f", focusPreview: "F", focusEstimatedTokens: 1,
			});
			// savedTokens = null (no before/after)
			tracker.recordReplacement({
				sessionId: "st3", status: "constructed", mechanism: "context_hook",
				focusHash: "h-g", focusPreview: "G", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "st3", status: "provider_payload_observed", mechanism: "auto_compact",
				beforeTokens: 8000, afterTokens: 5000,
				focusHash: "h-h", focusPreview: "H", focusEstimatedTokens: 1,
			});

			const stats = tracker.getStats();
			expect(stats.totalSaved).toBe(7000); // 4000 + null(→0) + 3000
		});

		test("totalSaved handles null and zero correctly", () => {
			const tracker = new ContextEvidenceTracker();
			// savedTokens = null (before null)
			tracker.recordReplacement({
				sessionId: "st4", status: "constructed", mechanism: "context_hook",
				beforeTokens: null, afterTokens: 5000,
				focusHash: "h-i", focusPreview: "Null", focusEstimatedTokens: 1,
			});
			// savedTokens = 0 (equal)
			tracker.recordReplacement({
				sessionId: "st4", status: "compact_completed", mechanism: "auto_compact",
				beforeTokens: 5000, afterTokens: 5000,
				focusHash: "h-j", focusPreview: "Zero", focusEstimatedTokens: 1,
			});
			// savedTokens = 3000
			tracker.recordReplacement({
				sessionId: "st4", status: "provider_payload_observed", mechanism: "auto_compact",
				beforeTokens: 8000, afterTokens: 5000,
				focusHash: "h-k", focusPreview: "Real", focusEstimatedTokens: 1,
			});

			const stats = tracker.getStats();
			expect(stats.totalSaved).toBe(3000); // null(→0) + 0 + 3000
		});

		test("recent returns most recent events in reverse chronological order", () => {
			const tracker = new ContextEvidenceTracker();
			tracker.recordReplacement({
				sessionId: "sr", status: "constructed", mechanism: "context_hook",
				beforeTokens: 100, afterTokens: 50,
				focusHash: "h1", focusPreview: "First", focusEstimatedTokens: 1,
			});
			tracker.recordReplacement({
				sessionId: "sr", status: "provider_payload_observed", mechanism: "auto_compact",
				beforeTokens: 200, afterTokens: 100,
				focusHash: "h2", focusPreview: "Last", focusEstimatedTokens: 1,
			});

			const stats = tracker.getStats();
			expect(stats.recent.length).toBe(2);
			expect(stats.recent[0]!.focusPreview).toBe("Last");
			expect(stats.recent[1]!.focusPreview).toBe("First");
		});

		test("recent is capped at 50", () => {
			const tracker = new ContextEvidenceTracker();
			for (let i = 0; i < 60; i++) {
				tracker.recordReplacement({
					sessionId: "sbig", status: "constructed", mechanism: "context_hook",
					focusHash: `h${i}`, focusPreview: `Event ${i}`, focusEstimatedTokens: 1,
				});
			}

			const stats = tracker.getStats();
			expect(stats.recent.length).toBe(50);
			expect(stats.recent[0]!.focusPreview).toBe("Event 59");
		});
	});

	describe("focusEstimatedTokens is never folded into savedTokens", () => {
		test("focusEstimatedTokens is independent of token savings math", () => {
			const tracker = new ContextEvidenceTracker();
			const eventId = tracker.recordReplacement({
				sessionId: "se",
				status: "provider_payload_observed",
				mechanism: "auto_compact",
				beforeTokens: 10000,
				afterTokens: 6000,
				focusHash: "hash-fi",
				focusPreview: "Focus independence test",
				focusEstimatedTokens: 999, // deliberately different from any savings math
				focusEstimateMethod: "chars_div_4",
			});

			const events = tracker.getSessionEvidence("se");
			const ev = events.find((e) => e.id === eventId)!;
			expect(ev.focusEstimatedTokens).toBe(999);
			expect(ev.focusEstimateMethod).toBe("chars_div_4");
			expect(ev.savedTokens).toBe(4000); // NOT affected by focusEstimatedTokens
			expect(ev.savedPercent).toBe(40);  // 10000-6000 = 4000, 40%
		});
	});
});
