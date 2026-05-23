import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createInbox, getInbox, listInbox } from "../../db/inbox.ts";
import { closeDb, openDb } from "../../db/index.ts";
import { createTask, findStateByName, getTask, listTasks } from "../../db/tasks.ts";
import type { RunContext } from "../types.ts";
import { executeDeckStep } from "./deck.ts";

let dbDir: string | null = null;

afterEach(() => {
	closeDb();
	if (dbDir) {
		try {
			fs.rmSync(dbDir, { recursive: true, force: true });
		} catch {
			// Windows SQLite handle release can lag slightly after close(); leaking a
			// temp test dir is fine, failing the suite is not.
		}
		dbDir = null;
	}
});

function bootDb(): void {
	dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-step-"));
	openDb({ path: path.join(dbDir, "deck.db") });
}

function ctx(): RunContext {
	return {
		run: {
			id: "run_test_01",
			started: "2026-05-21T00:00:00.000Z",
			iso_started: "2026-05-21T00:00:00.000Z",
			date: "2026-05-21",
			trigger_kind: "manual",
		},
		trigger: {},
		steps: {},
		env: {},
		secrets: {},
		state: {},
	};
}

describe("executeDeckStep", () => {
	test("create_inbox_item creates a native inbox item", async () => {
		bootDb();
		const result = await executeDeckStep(
			{
				id: "capture",
				type: "deck",
				action: "create_inbox_item",
				kind: "capture",
				title: "Morning briefing - {{ run.date }}",
				body: "hello from {{ run.id }}",
				source: "routine:test",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const items = listInbox({ includeProcessed: true });
		expect(items.some((i) => i.title === "Morning briefing - 2026-05-21")).toBe(true);
		expect(result.json).toMatchObject({ kind: "capture", source: "routine:test" });
	});

	test("create_task resolves state_ref by name", async () => {
		bootDb();
		const result = await executeDeckStep(
			{
				id: "task",
				type: "deck",
				action: "create_task",
				title: "Follow up {{ run.date }}",
				body: "from {{ run.id }}",
				state_ref: "backlog",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const task = result.json as ReturnType<typeof getTask>;
		expect(task?.title).toBe("Follow up 2026-05-21");
		expect(task?.body).toBe("from run_test_01");
		expect(task?.stateId).toBe(findStateByName("backlog")?.id);
	});

	test("move_task accepts T-N refs and moves to target state/index", async () => {
		bootDb();
		const done = findStateByName("done");
		if (!done) throw new Error("done state missing");
		const created = createTask({ title: "Move me" });
		const result = await executeDeckStep(
			{
				id: "move",
				type: "deck",
				action: "move_task",
				task_ref: `T-${created.displayId}`,
				state_ref: "done",
				index: 0,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const moved = getTask(created.id);
		expect(moved?.stateId).toBe(done.id);
	});

	test("promote_inbox_item_to_task creates task and marks inbox processed by default", async () => {
		bootDb();
		const item = createInbox({ kind: "capture", title: "Promote me", body: "hello" });
		const result = await executeDeckStep(
			{
				id: "promote",
				type: "deck",
				action: "promote_inbox_item_to_task",
				inbox_ref: item.id,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const promoted = result.json as { task: { title: string }; inbox: { processedAt?: string } };
		expect(promoted.task.title).toBe("Promote me");
		expect(promoted.inbox.processedAt).toBeDefined();
		expect(getInbox(item.id)?.processedAt).toBeDefined();
		expect(listTasks().some((t) => t.title === "Promote me")).toBe(true);
	});

	test("list_tasks with state_ref filters to that state only", async () => {
		bootDb();
		const active = findStateByName("active");
		const done = findStateByName("done");
		if (!active || !done) throw new Error("seed states missing");
		const t1 = createTask({ title: "active task", stateId: active.id });
		const t2 = createTask({ title: "done task", stateId: done.id });
		const result = await executeDeckStep(
			{
				id: "list_active",
				type: "deck",
				action: "list_tasks",
				state_ref: "active",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		const tasks = result.json as Array<{ id: string }>;
		expect(tasks.some((t) => t.id === t1.id)).toBe(true);
		expect(tasks.some((t) => t.id === t2.id)).toBe(false);
	});

	test("list_tasks limit caps the returned array", async () => {
		bootDb();
		for (let i = 0; i < 5; i++) createTask({ title: `task ${i}` });
		const result = await executeDeckStep(
			{
				id: "limited",
				type: "deck",
				action: "list_tasks",
				limit: 3,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		const tasks = result.json as unknown[];
		expect(tasks.length).toBe(3);
	});

	test("list_tasks returns a slim summary (no body) so agent prompts stay small", async () => {
		bootDb();
		createTask({ title: "fat one", body: "x".repeat(5000) });
		const result = await executeDeckStep(
			{ id: "slim", type: "deck", action: "list_tasks" },
			ctx(),
			AbortSignal.timeout(1000),
		);
		const tasks = result.json as Array<Record<string, unknown>>;
		expect(tasks.length).toBeGreaterThan(0);
		const sample = tasks[0]!;
		// Required summary fields are present.
		expect(typeof sample.id).toBe("string");
		expect(typeof sample.title).toBe("string");
		expect(typeof sample.ref).toBe("string");
		expect(typeof sample.displayId).toBe("number");
		// Heavy fields are intentionally absent so agent prompts stay bounded.
		expect("body" in sample).toBe(false);
		expect("cwd" in sample).toBe(false);
		expect("orderInState" in sample).toBe(false);
	});

	test("list_inbox returns a slim summary (no body)", async () => {
		bootDb();
		createInbox({ kind: "capture", title: "fat capture", body: "x".repeat(5000) });
		const result = await executeDeckStep(
			{ id: "slim_inbox", type: "deck", action: "list_inbox" },
			ctx(),
			AbortSignal.timeout(1000),
		);
		const items = result.json as Array<Record<string, unknown>>;
		expect(items.length).toBe(1);
		const sample = items[0]!;
		expect(typeof sample.id).toBe("string");
		expect(typeof sample.title).toBe("string");
		expect(typeof sample.kind).toBe("string");
		expect("body" in sample).toBe(false);
	});

	test("list_inbox kind filter returns only matching kind", async () => {
		bootDb();
		createInbox({ kind: "capture", title: "cap" });
		createInbox({ kind: "idea", title: "idea1" });
		createInbox({ kind: "idea", title: "idea2" });
		const result = await executeDeckStep(
			{
				id: "list_ideas",
				type: "deck",
				action: "list_inbox",
				kind: "idea",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		const items = result.json as Array<{ kind: string }>;
		expect(items.length).toBe(2);
		expect(items.every((i) => i.kind === "idea")).toBe(true);
	});

	test("get_task resolves T-N refs and returns the task", async () => {
		bootDb();
		const created = createTask({ title: "fetch me" });
		const result = await executeDeckStep(
			{
				id: "get",
				type: "deck",
				action: "get_task",
				task_ref: `T-${created.displayId}`,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		expect((result.json as { id: string }).id).toBe(created.id);
	});

	test("get_inbox_item returns the item by id", async () => {
		bootDb();
		const item = createInbox({ kind: "capture", title: "needle" });
		const result = await executeDeckStep(
			{
				id: "get_inbox",
				type: "deck",
				action: "get_inbox_item",
				inbox_ref: item.id,
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("success");
		expect((result.json as { title: string }).title).toBe("needle");
	});

	test("get_task on a missing ref returns a failed result with a clear error", async () => {
		bootDb();
		const result = await executeDeckStep(
			{
				id: "get_missing",
				type: "deck",
				action: "get_task",
				task_ref: "T-9999",
			},
			ctx(),
			AbortSignal.timeout(1000),
		);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("T-9999");
	});
});
