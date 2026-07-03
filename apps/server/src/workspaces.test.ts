import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	composeWorkspaceEntries,
	createUserWorkspace,
	deleteUserWorkspace,
	initWorkspaceSchemaForTest,
	listUserWorkspaces,
} from "./workspaces.ts";

let tmp: string | undefined;

afterEach(async () => {
	if (tmp) await fs.rm(tmp, { recursive: true, force: true });
	tmp = undefined;
});

async function tempDir(): Promise<string> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-workspaces-"));
	return tmp;
}

function db(): Database {
	const database = new Database(":memory:", { strict: true });
	initWorkspaceSchemaForTest(database);
	return database;
}

describe("user workspaces", () => {
	test("creates a row for an existing directory", async () => {
		const root = await tempDir();
		const database = db();
		const row = await createUserWorkspace(database, { cwd: root, label: "Repo" });
		expect(row.cwd).toBe(path.resolve(root));
		expect(row.label).toBe("Repo");
		expect(row.source).toBe("user");
		expect(row.id.startsWith("w_")).toBe(true);
	});

	test("creates a missing directory when requested", async () => {
		const root = await tempDir();
		const child = path.join(root, "new-project");
		const row = await createUserWorkspace(db(), { cwd: child, createDirectory: true });
		expect((await fs.stat(child)).isDirectory()).toBe(true);
		expect(row.label).toBe("new-project");
	});

	test("rejects relative paths and existing files", async () => {
		const root = await tempDir();
		const file = path.join(root, "file.txt");
		await fs.writeFile(file, "x");
		await expect(createUserWorkspace(db(), { cwd: "relative" })).rejects.toThrow(/absolute/);
		await expect(createUserWorkspace(db(), { cwd: file })).rejects.toThrow(/directory/);
	});

	test("updates an existing row label for duplicate cwd", async () => {
		const root = await tempDir();
		const database = db();
		const first = await createUserWorkspace(database, { cwd: root, label: "Old" });
		const second = await createUserWorkspace(database, { cwd: root, label: "New" });
		expect(second.id).toBe(first.id);
		expect(second.label).toBe("New");
		expect(listUserWorkspaces(database)[0]?.label).toBe("New");
	});

	test("deletes only user workspace rows", async () => {
		const root = await tempDir();
		const database = db();
		const row = await createUserWorkspace(database, { cwd: root });
		expect(deleteUserWorkspace(database, row.id)).toBe(true);
		expect(await fs.stat(root)).toBeTruthy();
		expect(listUserWorkspaces(database)).toEqual([]);
		expect(deleteUserWorkspace(database, row.id)).toBe(false);
	});

	test("composes default env user and session workspaces with counts", async () => {
		const root = await tempDir();
		const defaultCwd = path.join(root, "default");
		const envCwd = path.join(root, "env");
		const userCwd = path.join(root, "user");
		const sessionOnly = path.join(root, "session");
		await fs.mkdir(defaultCwd);
		await fs.mkdir(envCwd);
		await fs.mkdir(userCwd);
		await fs.mkdir(sessionOnly);
		const database = db();
		const user = await createUserWorkspace(database, { cwd: userCwd, label: "Pinned" });
		const entries = composeWorkspaceEntries({
			defaultCwd,
			extraWorkspaces: [envCwd],
			userWorkspaces: listUserWorkspaces(database),
			sessionCwds: [userCwd, userCwd, sessionOnly],
		});
		expect(entries.find((entry) => entry.cwd === defaultCwd)?.source).toBe("default");
		expect(entries.find((entry) => entry.cwd === envCwd)?.source).toBe("env");
		expect(entries.find((entry) => entry.cwd === userCwd)).toMatchObject({ id: user.id, source: "user", sessionCount: 2 });
		expect(entries.find((entry) => entry.cwd === sessionOnly)?.source).toBe("session");
	});
});
