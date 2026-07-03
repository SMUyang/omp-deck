import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";
import type { DeleteWorkspaceResponse, ListWorkspacesResponse, SessionSummary } from "@omp-deck/protocol";
import { buildWorkspacesRouter } from "./routes-workspaces.ts";
import { initWorkspaceSchemaForTest } from "./workspaces.ts";

let tmp: string | undefined;
afterEach(async () => {
	if (tmp) await fs.rm(tmp, { recursive: true, force: true });
	tmp = undefined;
});

async function appWithSessions(): Promise<{ app: Hono; root: string; sessionCwds: string[] }> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-workspace-routes-"));
	const defaultCwd = path.join(tmp, "default");
	await fs.mkdir(defaultCwd);
	const db = new Database(":memory:", { strict: true });
	initWorkspaceSchemaForTest(db);
	const config = { defaultCwd, extraWorkspaces: [] } as unknown as Config;
	const sessionCwds: string[] = [];
	const bridge: Pick<AgentBridge, "listSessions"> = {
		listSessions: async () =>
			sessionCwds.map((cwd, index): SessionSummary => ({
				id: `s${index}`,
				path: `${cwd}/session.jsonl`,
				cwd,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 0,
			})),
	};
	const app = new Hono();
	app.route("/", buildWorkspacesRouter({ config, db, bridge }));
	return { app, root: tmp, sessionCwds };
}

describe("workspace routes", () => {
	test("GET lists default and session-derived workspaces", async () => {
		const { app, root, sessionCwds } = await appWithSessions();
		sessionCwds.push(path.join(root, "session"));
		const body = (await (await app.request("/workspaces")).json()) as ListWorkspacesResponse;
		expect(body.defaultCwd).toContain("default");
		expect(body.workspaces.some((entry) => entry.source === "default")).toBe(true);
		expect(body.workspaces.some((entry) => entry.source === "session")).toBe(true);
	});

	test("POST creates a missing workspace directory and returns refreshed list", async () => {
		const { app, root } = await appWithSessions();
		const cwd = path.join(root, "created");
		const res = await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, label: "Created", createDirectory: true }) });
		expect(res.status).toBe(200);
		expect((await fs.stat(cwd)).isDirectory()).toBe(true);
		const body = (await res.json()) as import("@omp-deck/protocol").CreateWorkspaceResponse;
		expect(body.workspace).toMatchObject({ cwd, label: "Created", source: "user" });
		expect(body.workspaces.find((entry) => entry.cwd === cwd)).toMatchObject({ label: "Created", source: "user" });
 
	});

	test("POST returns the canonical resolved workspace path", async () => {
		const { app, root } = await appWithSessions();
		const canonical = path.join(root, "canonical");
		const input = path.join(root, ".", "canonical", "");
		const res = await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: input, label: "Canonical", createDirectory: true }) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as import("@omp-deck/protocol").CreateWorkspaceResponse;
		expect(body.workspace.cwd).toBe(canonical);
		expect(body.workspaces.find((entry) => entry.cwd === canonical)).toBeTruthy();
	});

	test("POST rejects relative paths and file paths", async () => {
		const { app, root } = await appWithSessions();
		const file = path.join(root, "file.txt");
		await fs.writeFile(file, "x");
		expect((await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "relative" }) })).status).toBe(400);
		expect((await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: file }) })).status).toBe(400);
	});

	test("DELETE removes user workspace rows without deleting directories", async () => {
		const { app, root } = await appWithSessions();
		const cwd = path.join(root, "created");
		const created = (await (await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, createDirectory: true }) })).json()) as ListWorkspacesResponse;
		const user = created.workspaces.find((entry) => entry.source === "user");
		if (!user?.id) throw new Error("expected a user workspace id");
		const deleted = await app.request(`/workspaces/${user.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect((await fs.stat(cwd)).isDirectory()).toBe(true);
		const body = (await deleted.json()) as DeleteWorkspaceResponse;
		expect(body.workspaces.some((entry) => entry.cwd === cwd)).toBe(false);
		expect((await app.request(`/workspaces/${user.id}`, { method: "DELETE" })).status).toBe(404);
	});
});
