import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { Config } from "./config.ts";
import { closeDb, openDb } from "./db/index.ts";
import { KbService } from "./kb-service.ts";
import { MarketplaceService } from "./marketplace-service.ts";
import { buildRouter } from "./routes.ts";
import { RoutinesRunner } from "./routines-runner.ts";
import { SkillsService } from "./skills-service.ts";

let tmp: string | undefined;

afterEach(async () => {
	closeDb();
	if (tmp) await fs.rm(tmp, { recursive: true, force: true });
	tmp = undefined;
});

async function bootActiveSessionRoute(): Promise<{ app: ReturnType<typeof buildRouter>; file: string; disposed: () => boolean }> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-active-delete-"));
	const file = path.join(tmp, "session.jsonl");
	await fs.writeFile(file, "{}\n");
	openDb({ path: path.join(tmp, "deck.db") });

	let didDispose = false;
	const handle = {
		sessionId: "active-session",
		sessionFile: file,
		cwd: tmp,
		dispose: async () => {
			didDispose = true;
		},
	} as unknown as SessionHandle;
	const bridge = {
		getSession: (id: string) => (id === "active-session" ? handle : undefined),
		listSessions: async () => {
			try {
				await fs.stat(file);
			} catch {
				return [];
			}
			return [
				{
					id: "active-session",
					path: file,
					cwd: tmp!,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					messageCount: 1,
				},
			];
		},
	} as unknown as AgentBridge;
	const config: Config = {
		host: "127.0.0.1",
		port: 0,
		defaultCwd: tmp,
		extraWorkspaces: [],
		devMode: true,
		idleTimeoutMs: 0,
		dbPath: path.join(tmp, "deck.db"),
		uploadsRoot: path.join(tmp, "uploads"),
		autoStartCommand: null,
		agentBackend: "rpc",
		ompBin: "omp",
	};
	const marketplace = new MarketplaceService();
	const app = buildRouter(
		bridge,
		config,
		new RoutinesRunner(),
		new BridgeSupervisor([]),
		marketplace,
		new SkillsService(config, marketplace),
		new KbService({ root: path.join(tmp, "kb") }),
	);
	return { app, file, disposed: () => didDispose };
}

describe("DELETE /sessions/:id", () => {
	test("deletes the session file for active sessions after disposing the handle", async () => {
		const { app, file, disposed } = await bootActiveSessionRoute();

		const res = await app.request("/sessions/active-session", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(disposed()).toBe(true);
		await expect(fs.stat(file)).rejects.toThrow();
		const listRes = await app.request("/sessions");
		const body = (await listRes.json()) as { sessions: Array<{ id: string }> };
		expect(body.sessions.some((session) => session.id === "active-session")).toBe(false);
	});
});
