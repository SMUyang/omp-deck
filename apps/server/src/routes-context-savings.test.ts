import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ContextEvidenceStats, ContextReplacementEvent } from "@omp-deck/protocol";
import { closeDb, getDb, openDb } from "./db/index.ts";
import { buildContextSavingsRouter } from "./routes-context-savings.ts";

const tempDirs: string[] = [];

function openTempDeckDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-savings-db-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "deck.db");
	openDb({ path: dbPath });
	return dbPath;
}

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function expectDefined<T>(value: T | undefined, label: string): T {
	expect(value).toBeDefined();
	if (value === undefined) throw new Error(`expected ${label}`);
	return value;
}

function expectContextEvidenceStats(value: unknown): asserts value is ContextEvidenceStats {
	expect(value).not.toBeNull();
	expect(typeof value).toBe("object");
	if (value === null || typeof value !== "object") throw new Error("expected context evidence stats object");
	expect("total" in value).toBe(true);
	expect("completed" in value).toBe(true);
	expect("totalSaved" in value).toBe(true);
	expect("recent" in value).toBe(true);
	if (!("total" in value) || typeof value.total !== "number") throw new Error("expected numeric total");
	if (!("completed" in value) || typeof value.completed !== "number") throw new Error("expected numeric completed");
	if (!("totalSaved" in value) || typeof value.totalSaved !== "number") throw new Error("expected numeric totalSaved");
	if (!("recent" in value) || !Array.isArray(value.recent)) throw new Error("expected recent event array");
}

function ensureTable(dbPath: string): void {
	// Migration 008 may not exist yet; create the table manually for tests.
	const db = getDb();
	db.exec(`
		CREATE TABLE IF NOT EXISTS context_replacement_events (
			id                  TEXT PRIMARY KEY,
			session_id          TEXT NOT NULL,
			status              TEXT NOT NULL CHECK (status IN (
				'constructed', 'handler_returned', 'compact_requested',
				'compact_completed', 'usage_drop_observed',
				'provider_payload_observed', 'failed', 'timed_out'
			)),
			mechanism           TEXT NOT NULL CHECK (mechanism IN ('context_hook', 'auto_compact')),
			before_tokens        INTEGER,
			before_percent       REAL,
			after_tokens         INTEGER,
			after_percent        REAL,
			saved_tokens         INTEGER,
			saved_percent        REAL,
			focus_hash           TEXT NOT NULL,
			focus_preview        TEXT NOT NULL,
			focus_estimated_tokens INTEGER NOT NULL,
			provider_role        TEXT,
			error_message        TEXT,
			retry_count          INTEGER NOT NULL DEFAULT 0,
			created_at           TEXT NOT NULL,
			updated_at           TEXT NOT NULL
		);
	`);
	// Suppress migration tracking so the real migration 008 isn't skipped later.
	db.exec(`DELETE FROM schema_migrations WHERE name = '008-context-evidence.sql'`);
}

function insertEvent(dbPath: string, overrides: Partial<{
	sessionId: string;
	status: string;
	mechanism: string;
	beforeTokens: number | null;
	beforePercent: number | null;
	afterTokens: number | null;
	afterPercent: number | null;
	savedTokens: number | null;
	savedPercent: number | null;
	focusHash: string;
	focusPreview: string;
	estimatedFocusTokens: number;
	providerRole: string | null;
}> = {}, insertOrder = 0): string {
	const db = getDb();
	const id = `evt-${crypto.randomUUID().slice(0, 8)}`;
	// Stagger timestamps by insert order so recent ordering is deterministic.
	const ms = Date.now() + insertOrder;
	const now = new Date(ms).toISOString();
	const sessionId = overrides.sessionId ?? "s1";
	const status = overrides.status ?? "provider_payload_observed";
	const mechanism = overrides.mechanism ?? "auto_compact";
	const beforeTokens = "beforeTokens" in overrides ? (overrides.beforeTokens ?? null) : 12000;
	const beforePercent = "beforePercent" in overrides ? (overrides.beforePercent ?? null) : 15.85;
	const afterTokens = "afterTokens" in overrides ? (overrides.afterTokens ?? null) : 8500;
	const afterPercent = "afterPercent" in overrides ? (overrides.afterPercent ?? null) : 11.33;
	const savedTokens = "savedTokens" in overrides ? (overrides.savedTokens ?? null) : 3500;
	const savedPercent = "savedPercent" in overrides ? (overrides.savedPercent ?? null) : 29.17;
	const focusHash = overrides.focusHash ?? "abcd1234";
	const focusPreview = overrides.focusPreview ?? "Test focus preview text";
	const estimatedFocusTokens = overrides.estimatedFocusTokens ?? 12;
	const providerRole = "providerRole" in overrides ? (overrides.providerRole ?? null) : "default";

	db.run(
		`INSERT INTO context_replacement_events
			(id, session_id, status, mechanism, before_tokens, before_percent,
			 after_tokens, after_percent, saved_tokens, saved_percent,
			 focus_hash, focus_preview, focus_estimated_tokens, provider_role,
			 error_message, retry_count, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
		[
			id,
			sessionId,
			status,
			mechanism,
			beforeTokens,
			beforePercent,
			afterTokens,
			afterPercent,
			savedTokens,
			savedPercent,
			focusHash,
			focusPreview,
			estimatedFocusTokens,
			providerRole,
			now,
			now,
		],
	);
	return id;
}

describe("GET /stats/context-savings", () => {
	test("returns stats from DB events", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		// Insert 3 events with staggered timestamps: 2 completed, 1 in-progress.
		insertEvent(dbPath, { sessionId: "s1", status: "provider_payload_observed", savedTokens: 1000 }, 0);
		insertEvent(dbPath, { sessionId: "s2", status: "provider_payload_observed", savedTokens: 2000 }, 1);
		insertEvent(dbPath, { sessionId: "s1", status: "compact_completed", savedTokens: null }, 2);

		const app = buildContextSavingsRouter();
		const req = new Request("http://127.0.0.1/stats/context-savings");
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.total).toBe(3);
		expect(body.completed).toBe(2);
		expect(body.totalSaved).toBe(3000);
		expect(body.recent).toBeArray();
		expect(body.recent.length).toBe(3);
		// Most recent first (ordered by created_at DESC)
		expect(expectDefined(body.recent[0], "most recent event").status).toBe("compact_completed");
	});

	test("totalSaved is 0 when no completed events with saved tokens", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		insertEvent(dbPath, { sessionId: "s1", status: "constructed", savedTokens: null });
		insertEvent(dbPath, { sessionId: "s1", status: "handler_returned", savedTokens: null });

		const app = buildContextSavingsRouter();
		const req = new Request("http://127.0.0.1/stats/context-savings");
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.totalSaved).toBe(0);
	});

	test("stats survive tracker recreation (DB persistence)", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		insertEvent(dbPath, { sessionId: "s1", status: "provider_payload_observed", savedTokens: 500 });

		// First app instance
		let app = buildContextSavingsRouter();
		let req = new Request("http://127.0.0.1/stats/context-savings");
		let res = await app.fetch(req);
		let body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.total).toBe(1);
		expect(body.totalSaved).toBe(500);

		// Second app instance (simulates server restart — same DB)
		app = buildContextSavingsRouter();
		req = new Request("http://127.0.0.1/stats/context-savings");
		res = await app.fetch(req);
		body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.total).toBe(1);
		expect(body.totalSaved).toBe(500);
	});

	test("does not fabricate replacement events — only returns what's in DB", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		// No events inserted — but the old in-memory tracker might have some.
		// The route reads from DB, so it should return empty regardless.
		const app = buildContextSavingsRouter();
		const req = new Request("http://127.0.0.1/stats/context-savings");
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.total).toBe(0);
		expect(body.completed).toBe(0);
		expect(body.recent).toEqual([]);
	});

	test("null saved tokens preserved in recent list", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		insertEvent(dbPath, {
			sessionId: "s1",
			status: "provider_payload_observed",
			beforeTokens: null,
			afterTokens: 5000,
			savedTokens: null,
			savedPercent: null,
		});

		const app = buildContextSavingsRouter();
		const req = new Request("http://127.0.0.1/stats/context-savings");
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.totalSaved).toBe(0);
		const event = expectDefined(body.recent[0], "recent event with null savings");
		expect(event.savedTokens).toBeNull();
		expect(event.savedPercent).toBeNull();
		expect(event.beforeTokens).toBeNull();
		expect(event.afterTokens).toBe(5000);
	});

	test("zero saved tokens is valid (not null)", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		insertEvent(dbPath, { sessionId: "s1", status: "provider_payload_observed", savedTokens: 0, savedPercent: 0 });

		const app = buildContextSavingsRouter();
		const req = new Request("http://127.0.0.1/stats/context-savings");
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expectContextEvidenceStats(body);
		expect(body.totalSaved).toBe(0);
		const event = expectDefined(body.recent[0], "recent zero-savings event");
		expect(event.savedTokens).toBe(0);
		expect(event.savedPercent).toBe(0);
	});

	test("focus_estimated_tokens is separate from saved_tokens", async () => {
		const dbPath = openTempDeckDb();
		ensureTable(dbPath);

		insertEvent(dbPath, {
			sessionId: "s1",
			status: "provider_payload_observed",
			estimatedFocusTokens: 42,
			savedTokens: 3500,
		});

		const app = buildContextSavingsRouter();
		const req = new Request("http://127.0.0.1/stats/context-savings");
		const res = await app.fetch(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expectContextEvidenceStats(body);
		const event = expectDefined(body.recent[0], "recent event with focus estimate");
		expect(event.focusEstimatedTokens).toBe(42);
		expect(event.savedTokens).toBe(3500);
		// The estimate must never be folded into savedTokens.
		expect(event.savedTokens).not.toBe(42);
	});
});
