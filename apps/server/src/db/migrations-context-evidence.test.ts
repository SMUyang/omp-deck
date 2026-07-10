/**
 * Test that migration 008 creates the context_replacement_events table
 * with correct schema, indexes, and CHECK constraints.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, getDb, openDb } from "./index.ts";

const tempDirs: string[] = [];

function openTempDeckDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-evidence-db-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "deck.db");
	openDb({ path: dbPath });
	return dbPath;
}

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("migration 008-context-evidence", () => {
	test("creates context_replacement_events table with all columns", () => {
		openTempDeckDb();
		const db = getDb();

		// Verify the table exists
		const tableInfo = db
			.query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
				"PRAGMA table_info(context_replacement_events)",
			)
			.all();

		expect(tableInfo.length).toBeGreaterThan(0);

		const cols = new Map(tableInfo.map((c) => [c.name, c]));

		// id — TEXT PRIMARY KEY
		expect(cols.get("id")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("id")!.pk).toBe(1);

		// session_id — TEXT NOT NULL
		expect(cols.get("session_id")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("session_id")!.notnull).toBe(1);

		// status — TEXT NOT NULL with CHECK
		expect(cols.get("status")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("status")!.notnull).toBe(1);

		// mechanism — TEXT NOT NULL with CHECK
		expect(cols.get("mechanism")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("mechanism")!.notnull).toBe(1);

		// before_tokens — INTEGER (nullable)
		expect(cols.get("before_tokens")!.type.toUpperCase()).toBe("INTEGER");

		// before_percent — REAL
		expect(cols.get("before_percent")!.type.toUpperCase()).toBe("REAL");

		// after_tokens — INTEGER
		expect(cols.get("after_tokens")!.type.toUpperCase()).toBe("INTEGER");

		// after_percent — REAL
		expect(cols.get("after_percent")!.type.toUpperCase()).toBe("REAL");

		// saved_tokens — INTEGER
		expect(cols.get("saved_tokens")!.type.toUpperCase()).toBe("INTEGER");

		// saved_percent — REAL
		expect(cols.get("saved_percent")!.type.toUpperCase()).toBe("REAL");

		// focus_hash — TEXT NOT NULL
		expect(cols.get("focus_hash")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("focus_hash")!.notnull).toBe(1);

		// focus_preview — TEXT NOT NULL
		expect(cols.get("focus_preview")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("focus_preview")!.notnull).toBe(1);

		// focus_estimated_tokens — INTEGER NOT NULL
		expect(cols.get("focus_estimated_tokens")!.type.toUpperCase()).toBe("INTEGER");
		expect(cols.get("focus_estimated_tokens")!.notnull).toBe(1);
		// focus_estimate_method — TEXT NOT NULL DEFAULT 'chars_div_4'
		expect(cols.get("focus_estimate_method")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("focus_estimate_method")!.notnull).toBe(1);
		expect(cols.get("focus_estimate_method")!.dflt_value).toBe("'chars_div_4'");

		// provider_role — TEXT (nullable)
		expect(cols.get("provider_role")!.type.toUpperCase()).toBe("TEXT");

		// error_message — TEXT
		expect(cols.get("error_message")!.type.toUpperCase()).toBe("TEXT");

		// retry_count — INTEGER NOT NULL DEFAULT 0
		expect(cols.get("retry_count")!.type.toUpperCase()).toBe("INTEGER");
		expect(cols.get("retry_count")!.notnull).toBe(1);
		expect(cols.get("retry_count")!.dflt_value).toBe("0");

		// created_at — TEXT NOT NULL
		expect(cols.get("created_at")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("created_at")!.notnull).toBe(1);

		// updated_at — TEXT NOT NULL
		expect(cols.get("updated_at")!.type.toUpperCase()).toBe("TEXT");
		expect(cols.get("updated_at")!.notnull).toBe(1);
	});

	test("creates required indexes", () => {
		openTempDeckDb();
		const db = getDb();

		const indexList = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'context_replacement_events'",
			)
			.all()
			.map((r) => r.name);

		expect(indexList).toContain("idx_context_replacement_events_session");
		expect(indexList).toContain("idx_context_replacement_events_status");
		expect(indexList).toContain("idx_context_replacement_events_hash");
	});

	test("can insert and read an event row", () => {
		openTempDeckDb();
		const db = getDb();

		db.run(
			`INSERT INTO context_replacement_events
			 (id, session_id, status, mechanism, focus_hash, focus_preview,
			  focus_estimated_tokens, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"evt-001",
				"sess-abc",
				"constructed",
				"context_hook",
				"abc123def456",
				"Topology focus text preview…",
				6,
				"2026-07-10T00:00:00.000Z",
				"2026-07-10T00:00:00.000Z",
			],
		);

		const row = db
			.query<{
				id: string;
				session_id: string;
				status: string;
				mechanism: string;
				retry_count: number;
			}, []>("SELECT id, session_id, status, mechanism, retry_count FROM context_replacement_events WHERE id = ?")
			.get("evt-001")!;

		expect(row.id).toBe("evt-001");
		expect(row.session_id).toBe("sess-abc");
		expect(row.status).toBe("constructed");
		expect(row.mechanism).toBe("context_hook");
		expect(row.retry_count).toBe(0);
	});

	test("rejects invalid status via CHECK constraint", () => {
		openTempDeckDb();
		const db = getDb();

		expect(() =>
			db.run(
				`INSERT INTO context_replacement_events
				 (id, session_id, status, mechanism, focus_hash, focus_preview,
				  focus_estimated_tokens, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"evt-bad",
					"sess-abc",
					"bogus_status",
					"context_hook",
					"abc",
					"...",
					1,
					"2026-07-10T00:00:00.000Z",
					"2026-07-10T00:00:00.000Z",
				],
			),
		).toThrow();
	});

	test("rejects invalid mechanism via CHECK constraint", () => {
		openTempDeckDb();
		const db = getDb();

		expect(() =>
			db.run(
				`INSERT INTO context_replacement_events
				 (id, session_id, status, mechanism, focus_hash, focus_preview,
				  focus_estimated_tokens, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"evt-bad2",
					"sess-abc",
					"constructed",
					"manual_edit",
					"abc",
					"...",
					1,
					"2026-07-10T00:00:00.000Z",
					"2026-07-10T00:00:00.000Z",
				],
			),
		).toThrow();
	});

	test("retry_count defaults to 0 when omitted", () => {
		openTempDeckDb();
		const db = getDb();

		db.run(
			`INSERT INTO context_replacement_events
			 (id, session_id, status, mechanism, focus_hash, focus_preview,
			  focus_estimated_tokens, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"evt-002",
				"sess-def",
				"handler_returned",
				"auto_compact",
				"hash002",
				"Another focus preview…",
				5,
				"2026-07-10T00:00:00.000Z",
				"2026-07-10T00:00:00.000Z",
			],
		);

		const row = db
			.query<{ retry_count: number }, []>(
				"SELECT retry_count FROM context_replacement_events WHERE id = ?",
			)
			.get("evt-002")!;

		expect(row.retry_count).toBe(0);
	});

	test("all valid statuses are accepted", () => {
		openTempDeckDb();
		const db = getDb();

		const validStatuses = [
			"constructed",
			"handler_returned",
			"compact_requested",
			"compact_completed",
			"usage_drop_observed",
			"provider_payload_observed",
			"failed",
			"timed_out",
		];

		for (let i = 0; i < validStatuses.length; i++) {
			db.run(
				`INSERT INTO context_replacement_events
				 (id, session_id, status, mechanism, focus_hash, focus_preview,
				  focus_estimated_tokens, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					`evt-s${i}`,
					"sess-abc",
					validStatuses[i],
					"context_hook",
					`hash${i}`,
					"...",
					1,
					"2026-07-10T00:00:00.000Z",
					"2026-07-10T00:00:00.000Z",
				],
			);
		}

		const count = db
			.query<{ n: number }, []>("SELECT COUNT(*) as n FROM context_replacement_events")
			.get()!;
		expect(count.n).toBe(8);
	});

	test("migration is recorded in schema_migrations", () => {
		openTempDeckDb();
		const db = getDb();

		const row = db
			.query<{ name: string }, []>(
				"SELECT name FROM schema_migrations WHERE name = ?",
			)
			.get("008-context-evidence.sql");

		expect(row).not.toBeNull();
	});
});
