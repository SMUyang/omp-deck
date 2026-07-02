import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CreateWorkspaceRequest, WorkspaceEntry } from "@omp-deck/protocol";
import { id, nowIso } from "./db/index.ts";

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
	const trimmed = request.cwd.trim();
	// Deviation from plan: check isAbsolute on the RAW input before path.resolve,
	// otherwise relative paths are silently promoted to absolute and the
	// "must be absolute" rejection never fires.
	if (!path.isAbsolute(trimmed)) throw new Error("workspace path must be absolute");
	const cwd = path.resolve(trimmed);
	await ensureDirectory(cwd, request.createDirectory);
	const trimmedLabel = request.label?.trim();
	const label = trimmedLabel ? trimmedLabel : null;
	const now = nowIso();
	const row = db
		.query<UserWorkspaceRow, [string, string, string | null, string, string]>(
			`INSERT INTO workspaces (id, cwd, label, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(cwd) DO UPDATE SET
				label = COALESCE(excluded.label, workspaces.label),
				updated_at = excluded.updated_at
			 RETURNING id, cwd, label, created_at, updated_at`,
		)
		.get(`w_${id().toLowerCase()}`, cwd, label, now, now);
	if (!row) throw new Error("workspace upsert failed");
	return rowToEntry(row);
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
