/**
 * Unit tests for the kanban tasks/state DB layer. Boots a fresh on-disk
 * SQLite database under `os.tmpdir()` per test so the migrations run end-to-end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";
import {
	createState,
	createTask,
	listStates,
	listTasks,
	moveTask,
	reorderStates,
	updateTask,
} from "./tasks.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows SQLite handles can lag past close(); leaking a temp dir is
			// fine, failing the suite is not.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-tasks-db-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

describe("reorderStates", () => {
	test("renumbers positions in the supplied order with 100-unit gaps", () => {
		bootDb();
		// Add a fifth column on top of the four seeded by 001-init.sql.
		const upNext = createState({ name: "up-next", color: "#888888" });
		const before = listStates().map((s) => s.id);
		expect(before).toEqual(["s_backlog", "s_active", "s_blocked", "s_done", upNext.id]);

		const after = reorderStates(["s_done", "s_blocked", "s_active", "s_backlog", upNext.id]);
		expect(after.map((s) => s.id)).toEqual([
			"s_done",
			"s_blocked",
			"s_active",
			"s_backlog",
			upNext.id,
		]);
		expect(after.map((s) => s.position)).toEqual([100, 200, 300, 400, 500]);
	});

	test("rejects a missing id without mutating task_states", () => {
		bootDb();
		const original = listStates();
		expect(() => reorderStates(["s_done", "s_blocked", "s_active"])).toThrow(/expected 4 ids/);
		expect(listStates()).toEqual(original);
	});

	test("rejects an unknown id", () => {
		bootDb();
		const original = listStates();
		expect(() =>
			reorderStates(["s_done", "s_blocked", "s_active", "s_does_not_exist"]),
		).toThrow(/unknown state id/);
		expect(listStates()).toEqual(original);
	});

	test("rejects a duplicate id", () => {
		bootDb();
		const original = listStates();
		expect(() => reorderStates(["s_done", "s_done", "s_blocked", "s_active"])).toThrow(
			/duplicate state id/,
		);
		expect(listStates()).toEqual(original);
	});
});

describe("state_entered_at + recency sort", () => {
	test("createTask stamps state_entered_at to the creation timestamp", () => {
		bootDb();
		const t = createTask({ title: "first", stateId: "s_backlog" });
		expect(typeof t.stateEnteredAt).toBe("string");
		expect(t.stateEnteredAt.length).toBeGreaterThan(0);
		// On fresh insert, state_entered_at equals updated_at.
		expect(t.stateEnteredAt).toBe(t.updatedAt);
	});

	test("cross-column moveTask bumps state_entered_at; same-column does not", async () => {
		bootDb();
		const t = createTask({ title: "drift-victim", stateId: "s_backlog" });
		const original = t.stateEnteredAt;
		await new Promise((r) => setTimeout(r, 10));

		// Same-column move keeps state_entered_at.
		const sameCol = moveTask(t.id, "s_backlog", 0)!;
		expect(sameCol.stateEnteredAt).toBe(original);

		await new Promise((r) => setTimeout(r, 10));
		const crossCol = moveTask(t.id, "s_active", 0)!;
		expect(crossCol.stateEnteredAt).not.toBe(original);
		expect(new Date(crossCol.stateEnteredAt).getTime()).toBeGreaterThan(
			new Date(original).getTime(),
		);
	});

	test("moveTask preserves peers' state_entered_at when the moving card crosses columns", async () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_done" });
		await new Promise((r) => setTimeout(r, 5));
		const aEntered = a.stateEnteredAt;

		await new Promise((r) => setTimeout(r, 5));
		const b = createTask({ title: "b", stateId: "s_backlog" });

		await new Promise((r) => setTimeout(r, 10));
		// Move b into done — a should still carry its earlier state_entered_at.
		moveTask(b.id, "s_done", 0);
		const done = listTasks().filter((t) => t.stateId === "s_done");
		const aRow = done.find((t) => t.id === a.id)!;
		expect(aRow.stateEnteredAt).toBe(aEntered);
	});

	test("body edits via updateTask do not bump state_entered_at", async () => {
		bootDb();
		const t = createTask({ title: "edit-me", stateId: "s_backlog" });
		const before = t.stateEnteredAt;
		await new Promise((r) => setTimeout(r, 10));
		const updated = updateTask(t.id, { body: "new body" })!;
		expect(updated.stateEnteredAt).toBe(before);
	});

	test("listTasks orders each column by state_entered_at DESC", async () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_backlog" });
		await new Promise((r) => setTimeout(r, 5));
		const b = createTask({ title: "b", stateId: "s_backlog" });
		await new Promise((r) => setTimeout(r, 5));
		const c = createTask({ title: "c", stateId: "s_backlog" });

		// Backlog also holds the seeded welcome task, so filter to the rows
		// this test explicitly created and assert their relative ordering.
		const ids = new Set([a.id, b.id, c.id]);
		const ordered = listTasks()
			.filter((t) => ids.has(t.id))
			.map((t) => t.id);
		// Most recent first.
		expect(ordered).toEqual([c.id, b.id, a.id]);
	});

	test("re-entering a column puts the card back on top", async () => {
		bootDb();
		const a = createTask({ title: "a", stateId: "s_done" });
		await new Promise((r) => setTimeout(r, 5));
		const b = createTask({ title: "b", stateId: "s_done" });
		await new Promise((r) => setTimeout(r, 10));
		// Bounce `a` through backlog and back to done — it should now surface
		// at the top because state_entered_at re-stamps on cross-column.
		moveTask(a.id, "s_backlog", 0);
		await new Promise((r) => setTimeout(r, 5));
		moveTask(a.id, "s_done", 0);

		const done = listTasks().filter((t) => t.stateId === "s_done");
		expect(done.map((t) => t.id)).toEqual([a.id, b.id]);
	});
});
