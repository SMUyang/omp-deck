import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSummary } from "@omp-deck/protocol";

import { deletePersistedSession } from "./session-delete.ts";

let tmp: string | undefined;

afterEach(async () => {
	if (tmp) await fs.rm(tmp, { recursive: true, force: true });
	tmp = undefined;
});

async function boot(): Promise<{ file: string; summary: SessionSummary }> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-session-delete-"));
	const file = path.join(tmp, "session.jsonl");
	await fs.writeFile(file, "{}\n");
	return {
		file,
		summary: {
			id: "s1",
			path: file,
			cwd: tmp,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
		},
	};
}

describe("deletePersistedSession", () => {
	test("deletes the jsonl file for a matching persisted session", async () => {
		const { file, summary } = await boot();
		await expect(deletePersistedSession("s1", [summary])).resolves.toBe(true);
		await expect(fs.stat(file)).rejects.toThrow();
	});

	test("returns false when no session matches", async () => {
		const { file, summary } = await boot();
		await expect(deletePersistedSession("missing", [summary])).resolves.toBe(false);
		expect((await fs.stat(file)).isFile()).toBe(true);
	});

	test("rejects non-jsonl session paths", async () => {
		const { summary } = await boot();
		await expect(deletePersistedSession("s1", [{ ...summary, path: path.join(tmp!, "not-json.txt") }])).rejects.toThrow(/jsonl/);
	});
});
