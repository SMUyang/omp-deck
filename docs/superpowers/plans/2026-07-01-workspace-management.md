# Workspace Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DB-backed user-managed workspaces that can be created/registered, selected for sessions, and removed from the deck list without deleting files or sessions.

**Architecture:** Move workspace route logic into a dedicated server router backed by a focused SQLite workspace store. Extend the shared protocol with source/id metadata, then wire web API/store/UI actions around the existing workspace selector instead of redesigning navigation.

**Tech Stack:** Bun, Hono, Bun SQLite, React, Zustand, TypeScript, Vitest/Bun test.

---

## Files

- Create `apps/server/src/db/migrations/005-workspaces.sql`: workspace table and indexes.
- Create `apps/server/src/workspaces.ts`: DB helpers, path validation, workspace list composition.
- Create `apps/server/src/workspaces.test.ts`: unit tests for DB/path/list behavior.
- Create `apps/server/src/routes-workspaces.ts`: Hono router for workspace CRUD.
- Create `apps/server/src/routes-workspaces.test.ts`: HTTP route tests.
- Modify `apps/server/src/routes.ts`: mount `buildWorkspacesRouter` and remove inline `GET /workspaces`.
- Modify `packages/protocol/src/index.ts`: workspace source/id/request/response types.
- Modify `apps/web/src/lib/api.ts`: create/delete methods.
- Modify `apps/web/src/lib/store.ts`: create/delete workspace actions.
- Modify `apps/web/src/lib/store.test.ts`: store helper/action tests.
- Modify `apps/web/src/components/Sidebar.tsx`: add add/remove controls.
- Modify `apps/web/src/components/chat/SessionPicker.tsx`: add add control.
- Modify `apps/web/src/i18n/index.ts`: English and Chinese labels.

---

### Task 1: Server workspace persistence and route

**Files:**
- Create: `apps/server/src/db/migrations/005-workspaces.sql`
- Create: `apps/server/src/workspaces.ts`
- Create: `apps/server/src/workspaces.test.ts`
- Create: `apps/server/src/routes-workspaces.ts`
- Create: `apps/server/src/routes-workspaces.test.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Extend protocol types first**

Add to `packages/protocol/src/index.ts` near existing workspace types:

```ts
export type WorkspaceSource = "default" | "env" | "user" | "session";

export interface WorkspaceEntry {
	cwd: string;
	label: string;
	sessionCount: number;
	source: WorkspaceSource;
	id?: string;
}

export interface CreateWorkspaceRequest {
	cwd: string;
	label?: string;
	createDirectory?: boolean;
}

export interface DeleteWorkspaceResponse extends ListWorkspacesResponse {
	ok: true;
}
```

- [ ] **Step 2: Add migration**

Create `apps/server/src/db/migrations/005-workspaces.sql`:

```sql
-- 005-workspaces.sql
-- User-managed workspace registry. Rows here only affect deck's workspace list;
-- deleting a row never deletes files or OMP sessions.
CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    cwd         TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_updated ON workspaces(updated_at DESC);
```

- [ ] **Step 3: Write failing workspace unit tests**

Create `apps/server/src/workspaces.test.ts` with tests that call exported helpers from `workspaces.ts`:

```ts
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
```

- [ ] **Step 4: Run unit tests red**

Run:

```bash
bun test apps/server/src/workspaces.test.ts
```

Expected: fail because `apps/server/src/workspaces.ts` does not exist or exported helpers are missing.

- [ ] **Step 5: Implement workspace helpers**

Create `apps/server/src/workspaces.ts` with:

```ts
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CreateWorkspaceRequest, WorkspaceEntry } from "@omp-deck/protocol";

interface UserWorkspaceRow {
	id: string;
	cwd: string;
	label: string | null;
	created_at: string;
	updated_at: string;
}

export interface UserWorkspaceEntry extends WorkspaceEntry {
	id: string;
	source: "user";
}

const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    cwd         TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_updated ON workspaces(updated_at DESC);
`;

export function initWorkspaceSchemaForTest(db: Database): void {
	db.exec(WORKSPACE_SCHEMA);
}

export function deriveWorkspaceLabel(cwd: string): string {
	return path.basename(cwd) || cwd;
}

function nowIso(): string {
	return new Date().toISOString();
}

function workspaceId(): string {
	return `w_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function normalizeLabel(label: string | undefined): string | null {
	const trimmed = label?.trim();
	return trimmed ? trimmed : null;
}

async function ensureDirectory(cwd: string, createDirectory: boolean | undefined): Promise<void> {
	if (!path.isAbsolute(cwd)) throw new Error("workspace path must be absolute");
	try {
		const stat = await fs.stat(cwd);
		if (!stat.isDirectory()) throw new Error("workspace path must be a directory");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT" && createDirectory) {
			await fs.mkdir(cwd, { recursive: true });
			return;
		}
		if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("workspace path does not exist");
		throw err;
	}
}

function rowToEntry(row: UserWorkspaceRow): UserWorkspaceEntry {
	return {
		id: row.id,
		cwd: row.cwd,
		label: row.label || deriveWorkspaceLabel(row.cwd),
		sessionCount: 0,
		source: "user",
	};
}

export function listUserWorkspaces(db: Database): UserWorkspaceEntry[] {
	const rows = db
		.query<UserWorkspaceRow, []>("SELECT id, cwd, label, created_at, updated_at FROM workspaces ORDER BY updated_at DESC")
		.all();
	return rows.map(rowToEntry);
}

export async function createUserWorkspace(db: Database, request: CreateWorkspaceRequest): Promise<UserWorkspaceEntry> {
	const cwd = path.resolve(request.cwd.trim());
	await ensureDirectory(cwd, request.createDirectory);
	const existing = db.query<UserWorkspaceRow, [string]>("SELECT id, cwd, label, created_at, updated_at FROM workspaces WHERE cwd = ?").get(cwd);
	const label = normalizeLabel(request.label);
	const now = nowIso();
	if (existing) {
		db.prepare<unknown, [string | null, string, string]>("UPDATE workspaces SET label = COALESCE(?, label), updated_at = ? WHERE id = ?").run(label, now, existing.id);
		const updated = db.query<UserWorkspaceRow, [string]>("SELECT id, cwd, label, created_at, updated_at FROM workspaces WHERE id = ?").get(existing.id);
		if (!updated) throw new Error("workspace update failed");
		return rowToEntry(updated);
	}
	const id = workspaceId();
	db.prepare<unknown, [string, string, string | null, string, string]>(
		"INSERT INTO workspaces (id, cwd, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	).run(id, cwd, label, now, now);
	return { id, cwd, label: label || deriveWorkspaceLabel(cwd), sessionCount: 0, source: "user" };
}

export function deleteUserWorkspace(db: Database, id: string): boolean {
	const result = db.prepare<unknown, [string]>("DELETE FROM workspaces WHERE id = ?").run(id);
	return result.changes > 0;
}

export function composeWorkspaceEntries(input: {
	defaultCwd: string;
	extraWorkspaces: readonly string[];
	userWorkspaces: readonly UserWorkspaceEntry[];
	sessionCwds: readonly string[];
}): WorkspaceEntry[] {
	const counts = new Map<string, number>();
	for (const cwd of input.sessionCwds) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
	const entries = new Map<string, WorkspaceEntry>();
	const upsert = (entry: WorkspaceEntry): void => {
		entries.set(entry.cwd, { ...entry, sessionCount: counts.get(entry.cwd) ?? 0 });
	};
	upsert({ cwd: input.defaultCwd, label: deriveWorkspaceLabel(input.defaultCwd), sessionCount: 0, source: "default" });
	for (const cwd of input.extraWorkspaces) upsert({ cwd, label: deriveWorkspaceLabel(cwd), sessionCount: 0, source: "env" });
	for (const user of input.userWorkspaces) upsert(user);
	for (const cwd of counts.keys()) {
		if (!entries.has(cwd)) upsert({ cwd, label: deriveWorkspaceLabel(cwd), sessionCount: 0, source: "session" });
	}
	return Array.from(entries.values()).sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));
}
```

- [ ] **Step 6: Run unit tests green**

Run:

```bash
bun test apps/server/src/workspaces.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Write failing route tests**

Create `apps/server/src/routes-workspaces.test.ts` with a fake bridge and in-memory db. Test `GET`, `POST`, and `DELETE`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "./config.ts";
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
	const config = { defaultCwd, extraWorkspaces: [] } as Config;
	const sessionCwds: string[] = [];
	const bridge = { listSessions: async () => sessionCwds.map((cwd, index) => ({ id: `s${index}`, cwd })) };
	const app = new Hono();
	app.route("/", buildWorkspacesRouter({ config, db, bridge }));
	return { app, root: tmp, sessionCwds };
}

describe("workspace routes", () => {
	test("GET lists default and session-derived workspaces", async () => {
		const { app, root, sessionCwds } = await appWithSessions();
		sessionCwds.push(path.join(root, "session"));
		const body = await (await app.request("/workspaces")).json();
		expect(body.defaultCwd).toContain("default");
		expect(body.workspaces.some((entry: { source: string }) => entry.source === "default")).toBe(true);
		expect(body.workspaces.some((entry: { source: string }) => entry.source === "session")).toBe(true);
	});

	test("POST creates a missing workspace directory and returns refreshed list", async () => {
		const { app, root } = await appWithSessions();
		const cwd = path.join(root, "created");
		const res = await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, label: "Created", createDirectory: true }) });
		expect(res.status).toBe(200);
		expect((await fs.stat(cwd)).isDirectory()).toBe(true);
		const body = await res.json();
		expect(body.workspaces.find((entry: { cwd: string }) => entry.cwd === cwd)).toMatchObject({ label: "Created", source: "user" });
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
		const created = await (await app.request("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, createDirectory: true }) })).json();
		const user = created.workspaces.find((entry: { source: string }) => entry.source === "user");
		const deleted = await app.request(`/workspaces/${user.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect((await fs.stat(cwd)).isDirectory()).toBe(true);
		const body = await deleted.json();
		expect(body.workspaces.some((entry: { cwd: string }) => entry.cwd === cwd)).toBe(false);
		expect((await app.request(`/workspaces/${user.id}`, { method: "DELETE" })).status).toBe(404);
	});
});
```

- [ ] **Step 8: Run route tests red**

Run:

```bash
bun test apps/server/src/routes-workspaces.test.ts
```

Expected: fail because `routes-workspaces.ts` does not exist.

- [ ] **Step 9: Implement workspace router and mount it**

Create `apps/server/src/routes-workspaces.ts`:

```ts
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { CreateWorkspaceRequest, ListWorkspacesResponse, WorkspaceEntry } from "@omp-deck/protocol";
import type { Config } from "./config.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { composeWorkspaceEntries, createUserWorkspace, deleteUserWorkspace, listUserWorkspaces } from "./workspaces.ts";

export interface WorkspacesRouterDeps {
	config: Config;
	db: Database;
	bridge: Pick<AgentBridge, "listSessions">;
}

async function listEntries(deps: WorkspacesRouterDeps): Promise<ListWorkspacesResponse> {
	const allSessions = await deps.bridge.listSessions({});
	const workspaces: WorkspaceEntry[] = composeWorkspaceEntries({
		defaultCwd: deps.config.defaultCwd,
		extraWorkspaces: deps.config.extraWorkspaces,
		userWorkspaces: listUserWorkspaces(deps.db),
		sessionCwds: allSessions.map((session) => session.cwd).filter((cwd): cwd is string => Boolean(cwd)),
	});
	return { workspaces, defaultCwd: deps.config.defaultCwd };
}

function isCreateWorkspaceRequest(value: unknown): value is CreateWorkspaceRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.cwd !== "string" || record.cwd.trim().length === 0) return false;
	if (record.label !== undefined && typeof record.label !== "string") return false;
	if (record.createDirectory !== undefined && typeof record.createDirectory !== "boolean") return false;
	return true;
}

export function buildWorkspacesRouter(deps: WorkspacesRouterDeps): Hono {
	const app = new Hono();
	app.get("/workspaces", async (c) => c.json(await listEntries(deps)));
	app.post("/workspaces", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON body" }, 400);
		}
		if (!isCreateWorkspaceRequest(body)) return c.json({ error: "cwd is required" }, 400);
		try {
			await createUserWorkspace(deps.db, body);
			return c.json(await listEntries(deps));
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});
	app.delete("/workspaces/:id", async (c) => {
		const deleted = deleteUserWorkspace(deps.db, c.req.param("id"));
		if (!deleted) return c.json({ error: "workspace not found" }, 404);
		return c.json({ ok: true, ...(await listEntries(deps)) });
	});
	return app;
}
```

Modify `apps/server/src/routes.ts`:

```ts
import { getDb } from "./db/index.ts";
import { buildWorkspacesRouter } from "./routes-workspaces.ts";
```

Then replace the inline `app.get("/workspaces", ...)` block with:

```ts
app.route("/", buildWorkspacesRouter({ config, db: getDb(), bridge }));
```

- [ ] **Step 10: Run route and unit tests green**

Run:

```bash
bun test apps/server/src/workspaces.test.ts apps/server/src/routes-workspaces.test.ts
```

Expected: all tests pass.

- [ ] **Step 11: Commit server task**

Run:

```bash
git add packages/protocol/src/index.ts apps/server/src/db/migrations/005-workspaces.sql apps/server/src/workspaces.ts apps/server/src/workspaces.test.ts apps/server/src/routes-workspaces.ts apps/server/src/routes-workspaces.test.ts apps/server/src/routes.ts
git commit -m "Add server workspace management API"
```

---

### Task 2: Web API/store workspace actions

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/store.ts`
- Modify: `apps/web/src/lib/store.test.ts`

- [ ] **Step 1: Write failing store helper/action tests**

Add to `apps/web/src/lib/store.test.ts` pure helper tests for the reducer-like behavior to avoid brittle hook setup:

```ts
import type { ListWorkspacesResponse } from "@omp-deck/protocol";
import { workspaceStateFromResponse, selectedWorkspaceAfterDelete } from "./store";

const workspaceResponse: ListWorkspacesResponse = {
	defaultCwd: "/home/user",
	workspaces: [
		{ id: "w_1", cwd: "/repo", label: "repo", sessionCount: 0, source: "user" },
	],
};

test("workspaceStateFromResponse mirrors workspaces and default cwd", () => {
	expect(workspaceStateFromResponse(workspaceResponse)).toEqual({
		workspaces: workspaceResponse.workspaces,
		defaultCwd: "/home/user",
	});
});

test("selectedWorkspaceAfterDelete clears removed selected cwd", () => {
	expect(selectedWorkspaceAfterDelete("/repo", workspaceResponse.workspaces)).toBe("");
	expect(selectedWorkspaceAfterDelete("/other", workspaceResponse.workspaces)).toBe("/other");
});
```

- [ ] **Step 2: Run store tests red**

Run:

```bash
bun test apps/web/src/lib/store.test.ts
```

Expected: fail because exported helpers do not exist.

- [ ] **Step 3: Add API methods and store actions**

Modify `apps/web/src/lib/api.ts` imports:

```ts
CreateWorkspaceRequest,
DeleteWorkspaceResponse,
```

Add methods after `listWorkspaces()`:

```ts
createWorkspace(body: CreateWorkspaceRequest): Promise<ListWorkspacesResponse> {
	return request<ListWorkspacesResponse>("/workspaces", { method: "POST", body: JSON.stringify(body) });
},
deleteWorkspace(id: string): Promise<DeleteWorkspaceResponse> {
	return request<DeleteWorkspaceResponse>(`/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
},
```

Modify `StoreState` in `apps/web/src/lib/store.ts`:

```ts
createWorkspace(opts: import("@omp-deck/protocol").CreateWorkspaceRequest): Promise<void>;
deleteWorkspace(id: string): Promise<void>;
```

Add exported helpers near `applySessionSummarySnapshot`:

```ts
export function workspaceStateFromResponse(resp: ListWorkspacesResponse): { workspaces: WorkspaceEntry[]; defaultCwd: string } {
	return { workspaces: resp.workspaces, defaultCwd: resp.defaultCwd };
}

export function selectedWorkspaceAfterDelete(selectedCwd: string, remaining: WorkspaceEntry[]): string {
	return selectedCwd && !remaining.some((workspace) => workspace.cwd === selectedCwd) ? "" : selectedCwd;
}
```

Add store actions after `refreshWorkspaces()`:

```ts
async createWorkspace(opts) {
	const resp = await api.createWorkspace(opts);
	set(workspaceStateFromResponse(resp));
},

async deleteWorkspace(id) {
	const resp = await api.deleteWorkspace(id);
	set(workspaceStateFromResponse(resp));
},
```

- [ ] **Step 4: Run store tests green**

Run:

```bash
bun test apps/web/src/lib/store.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit web state task**

Run:

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/store.ts apps/web/src/lib/store.test.ts
git commit -m "Add workspace create delete client actions"
```

---

### Task 3: Workspace UI controls

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/chat/SessionPicker.tsx`
- Modify: `apps/web/src/i18n/index.ts`

- [ ] **Step 1: Add i18n labels**

Add keys under English and Chinese sidebar/session picker sections:

```ts
addWorkspace: "Add workspace",
removeWorkspace: "Remove workspace",
workspacePathPrompt: "Workspace directory path",
workspaceLabelPrompt: "Optional display label",
workspaceRemoveConfirm: "Remove this workspace from omp-deck? Files and sessions will not be deleted.",
workspaceCreateFailed: "Failed to add workspace",
workspaceDeleteFailed: "Failed to remove workspace",
```

Use equivalent Chinese labels in the `zh` block.

- [ ] **Step 2: Update Sidebar controls**

Modify imports in `apps/web/src/components/Sidebar.tsx`:

```ts
import { Plus, RefreshCw, Trash2 } from "lucide-react";
```

Read store actions:

```ts
const createWorkspace = useStore((s) => s.createWorkspace);
const deleteWorkspace = useStore((s) => s.deleteWorkspace);
```

Add selected workspace helpers after `cwdInUse`:

```ts
const selectedWorkspace = workspaces.find((workspace) => workspace.cwd === selectedCwd);
const canDeleteSelectedWorkspace = selectedWorkspace?.source === "user" && Boolean(selectedWorkspace.id);
```

Add handlers:

```ts
async function handleAddWorkspace(): Promise<void> {
	const cwd = window.prompt(t("sidebar.workspacePathPrompt"));
	if (!cwd?.trim()) return;
	const label = window.prompt(t("sidebar.workspaceLabelPrompt")) ?? undefined;
	try {
		await createWorkspace({ cwd: cwd.trim(), label, createDirectory: true });
		setSelectedCwd(cwd.trim());
		void refreshSessions(cwd.trim());
	} catch (err) {
		console.error(err);
		alert(`${t("sidebar.workspaceCreateFailed")}: ${String(err)}`);
	}
}

async function handleDeleteWorkspace(): Promise<void> {
	if (!selectedWorkspace?.id || !canDeleteSelectedWorkspace) return;
	if (!window.confirm(t("sidebar.workspaceRemoveConfirm"))) return;
	try {
		await deleteWorkspace(selectedWorkspace.id);
		setSelectedCwd("");
		void refreshSessions(undefined);
	} catch (err) {
		console.error(err);
		alert(`${t("sidebar.workspaceDeleteFailed")}: ${String(err)}`);
	}
}
```

Replace the current refresh-only button group with Add, conditional Delete, Refresh buttons. Preserve the existing select and new-session behavior.

- [ ] **Step 3: Update SessionPicker add control**

In `apps/web/src/components/chat/SessionPicker.tsx`, read `createWorkspace` from store and add `handleAddWorkspace()` with the same prompt/create/select logic, but without delete. Add a small secondary button near the workspace label.

- [ ] **Step 4: Typecheck web red/green as UI compiler gate**

Run:

```bash
bun run --filter '@omp-deck/web' typecheck
```

Expected: exit 0.

- [ ] **Step 5: Commit UI task**

Run:

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/chat/SessionPicker.tsx apps/web/src/i18n/index.ts
git commit -m "Add workspace management controls"
```

---

### Task 4: Final verification and deployment

**Files:**
- No planned source edits unless verification finds a defect.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
bun test apps/server/src/workspaces.test.ts apps/server/src/routes-workspaces.test.ts apps/web/src/lib/store.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typechecks**

Run:

```bash
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' typecheck
```

Expected: both exit 0.

- [ ] **Step 3: Run builds**

Run:

```bash
bun run --filter '@omp-deck/server' build
bun run --filter '@omp-deck/web' build
```

Expected: both exit 0.

- [ ] **Step 4: Browser/API smoke**

Start dev stack on non-default ports and verify:

```bash
OMP_DECK_PORT=8894 OMP_DECK_WEB_PORT=5180 bun run dev
```

Smoke sequence:

1. `GET http://127.0.0.1:8894/api/health?ts=<unique>` returns current build.
2. `POST /api/workspaces` with `{ cwd: <temp dir>/created, label: "Smoke Workspace", createDirectory: true }` returns a `source: "user"` workspace.
3. `DELETE /api/workspaces/<id>` returns `ok: true` and removes that cwd from the response.
4. Browser at `http://127.0.0.1:5180/?ts=<unique>` can load without console errors.

- [ ] **Step 5: Final review**

Dispatch a reviewer for the whole feature. Required result: APPROVED or all issues fixed and re-reviewed.

- [ ] **Step 6: Merge, push, deploy**

Use `finishing-a-development-branch`: fast-forward the deploy worktree, rerun targeted tests/typechecks/builds there, push `HEAD:main`, restart `start-rpc-deck.sh`, and smoke `/api/health` plus workspace POST/DELETE on port 8787.
