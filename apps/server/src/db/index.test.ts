/**
 * Test that openDb configures pragmas that prevent transient SQLITE_BUSY.
 * Regression: the routine runner's `startRun` INSERT intermittently failed
 * with SQLITE_BUSY because no `busy_timeout` was set.
 */
import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows handles can lag; leaking a temp dir is fine.
		}
		dbDir = null;
	}
});

describe("openDb pragmas", () => {
	test("sets busy_timeout so transient lock contention retries instead of throwing", () => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pragmas-"));
		const db = openDb({ path: path.join(dbDir, "test.db") });

		const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!;
		expect(row.timeout).toBeGreaterThanOrEqual(1000);
	});
});
