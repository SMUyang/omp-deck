import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSummary } from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import { closeDb, openDb } from "./db/index.ts";
import type { Config } from "./config.ts";
import type { KbService } from "./kb-service.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { SkillsService } from "./skills-service.ts";
import { buildRouter } from "./routes.ts";

const tempDirs: string[] = [];

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-session-delete-"));
	tempDirs.push(dir);
	return dir;
}

interface ActiveHandle {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	dispose(): Promise<void>;
}

function makeBridge(handle: ActiveHandle): AgentBridge {
	return {
		getSession: (id: string) => (id === handle.sessionId ? handle : undefined),
		listSessions: async () => {
			if (!fs.existsSync(handle.sessionFile)) return [];
			const summary: SessionSummary = {
				id: handle.sessionId,
				path: handle.sessionFile,
				cwd: handle.cwd,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
			};
			return [summary];
		},
	} as unknown as AgentBridge;
}

function makeConfig(dir: string): Config {
	return {
		host: "127.0.0.1",
		port: 0,
		defaultCwd: dir,
		extraWorkspaces: [],
		devMode: false,
		idleTimeoutMs: 0,
		dbPath: path.join(dir, "deck.db"),
		uploadsRoot: path.join(dir, "uploads"),
		autoStartCommand: null,
		ompBin: "omp",
	};
}

describe("DELETE /sessions/:id", () => {
	test("active-session branch disposes the handle, unlinks its sessionFile, and removes it from listings", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const sessionFile = path.join(dir, "active.jsonl");
		fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "active" })}\n`);

		let disposed = false;
		const handle: ActiveHandle = {
			sessionId: "active",
			sessionFile,
			cwd: dir,
			async dispose() {
				disposed = true;
			},
		};

		const app = buildRouter(
			makeBridge(handle),
			makeConfig(dir),
			{} as unknown as RoutinesRunner,
			{} as unknown as BridgeSupervisor,
			{} as unknown as MarketplaceService,
			{} as unknown as SkillsService,
			{} as unknown as KbService,
		);

		const res = await app.request("/sessions/active", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(disposed).toBe(true);
		await expect(fs.promises.stat(sessionFile)).rejects.toThrow();

		const listRes = await app.request("/sessions");
		const body = (await listRes.json()) as { sessions: Array<{ id: string }> };
		expect(body.sessions.some((session) => session.id === "active")).toBe(false);
	});
});
