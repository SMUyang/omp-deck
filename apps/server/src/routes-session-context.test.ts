import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import type {
	SessionContextGraphResponse,
	SessionContextPackResponse,
	SessionContextRebuildResponse,
	SessionContextStatusResponse,
} from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { closeDb, openDb } from "./db/index.ts";
import { buildSessionContextRouter } from "./routes-session-context.ts";

const jsonl = [
	JSON.stringify({ type: "title", v: 1, title: "Context topology" }),
	JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/repo", timestamp: "2026-07-02T00:00:00.000Z" }),
	JSON.stringify({ type: "message", id: "u1", timestamp: "2026-07-02T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "继续会话内拓扑记忆系统的搭建" }] } }),
	JSON.stringify({ type: "message", id: "a1", timestamp: "2026-07-02T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "推荐先做 Memory Cockpit 可视化拓扑。" }] } }),
	JSON.stringify({ type: "message", id: "u2", timestamp: "2026-07-02T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "我希望的是作为上下文数据的替换方法，节省上下文空间" }] } }),
	JSON.stringify({ type: "message", id: "tool1", timestamp: "2026-07-02T00:00:04.000Z", message: { role: "tool", content: [{ type: "text", text: "bun test apps/server/src/session-context.test.ts\n10 pass 0 fail" }] } }),
].join("\n");

const tempDirs: string[] = [];

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-session-context-"));
	tempDirs.push(dir);
	return dir;
}

interface StubHandle {
	sessionId: string;
	sessionFile?: string;
}

function makeBridge(handle: StubHandle | undefined, persistedIds: string[] = []): AgentBridge {
	return {
		getSession: () => handle,
		listSessions: async () => persistedIds.map((id) => ({
			id,
			path: `/tmp/${id}.jsonl`,
			cwd: "/repo",
			title: id,
			createdAt: "2026-07-02T00:00:00.000Z",
			updatedAt: "2026-07-02T00:00:00.000Z",
			messageCount: 1,
		})),
	} as unknown as AgentBridge;
}

function setupSession(): { app: Hono; sessionFile: string } {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });
	const sessionFile = path.join(dir, "s1.jsonl");
	fs.writeFileSync(sessionFile, jsonl);
	const app = buildSessionContextRouter(makeBridge({ sessionId: "s1", sessionFile }));
	return { app, sessionFile };
}

describe("session context routes", () => {
	describe("POST /sessions/:id/context/rebuild", () => {
		test("returns 404 when session not found", async () => {
			const app = buildSessionContextRouter(makeBridge(undefined));
			const res = await app.request("/sessions/missing/context/rebuild", { method: "POST" });
			expect(res.status).toBe(404);
		});

		test("returns 404 when handle exists but sessionFile is undefined", async () => {
			const app = buildSessionContextRouter(makeBridge({ sessionId: "s1" }));
			const res = await app.request("/sessions/s1/context/rebuild", { method: "POST" });
			expect(res.status).toBe(404);
		});

		test("returns 200 with nodeCount when session has a file", async () => {
			const { app, sessionFile } = setupSession();
			const res = await app.request("/sessions/s1/context/rebuild", { method: "POST" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextRebuildResponse;
			expect(body.nodeCount).toBeGreaterThan(0);
			expect(body.sourcePath).toBe(sessionFile);
			expect(body.sessionId).toBe("s1");
		});
	});

	describe("GET /sessions/:id/context-status", () => {
		test("returns 404 when session not found in active or persisted sessions", async () => {
			const app = buildSessionContextRouter(makeBridge(undefined, ["other"]));
			const res = await app.request("/sessions/missing/context-status");
			expect(res.status).toBe(404);
		});

		test("returns unbuilt status for an active session with no checkpoint", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const app = buildSessionContextRouter(makeBridge({ sessionId: "s1", sessionFile: path.join(dir, "s1.jsonl") }));

			const res = await app.request("/sessions/s1/context-status");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextStatusResponse;
			expect(body).toEqual({ sessionId: "s1", built: false, nodeCount: 0, edgeCount: 0 });
			expect("nodes" in body).toBe(false);
			expect("artifacts" in body).toBe(false);
		});

		test("returns unbuilt status for a persisted session row with no active handle", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const app = buildSessionContextRouter(makeBridge(undefined, ["persisted-s1"]));

			const res = await app.request("/sessions/persisted-s1/context-status");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextStatusResponse;
			expect(body).toEqual({ sessionId: "persisted-s1", built: false, nodeCount: 0, edgeCount: 0 });
		});

		test("returns built status after rebuild", async () => {
			const { app } = setupSession();
			await app.request("/sessions/s1/context/rebuild", { method: "POST" });

			const res = await app.request("/sessions/s1/context-status");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextStatusResponse;
			expect(body.sessionId).toBe("s1");
			expect(body.built).toBe(true);
			expect(body.nodeCount).toBeGreaterThan(0);
			expect(body.edgeCount).toBeGreaterThanOrEqual(0);
			expect(typeof body.rebuiltAt).toBe("string");
			expect(typeof body.sourceMtimeMs).toBe("number");
			expect(typeof body.sourceSizeBytes).toBe("number");
			expect("nodes" in body).toBe(false);
		});

		test("returns 500 with error body when bridge.listSessions throws", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const app = buildSessionContextRouter({
				getSession: () => undefined,
				listSessions: async () => {
					throw new Error("boom: list sessions failed");
				},
			} as unknown as AgentBridge);

			const res = await app.request("/sessions/s1/context-status");

			expect(res.status).toBe(500);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("boom: list sessions failed");
		});
	});

	describe("GET /sessions/:id/context-pack", () => {
		test("returns 404 when session not found", async () => {
			const app = buildSessionContextRouter(makeBridge(undefined));
			const res = await app.request("/sessions/missing/context-pack");
			expect(res.status).toBe(404);
		});

		test("returns pack with summary and goals after rebuild", async () => {
			const { app } = setupSession();
			await app.request("/sessions/s1/context/rebuild", { method: "POST" });
			const res = await app.request("/sessions/s1/context-pack?q=context&budget=4000");
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextPackResponse;
			expect(body.sessionId).toBe("s1");
			expect(typeof body.summary).toBe("string");
			expect(Array.isArray(body.goals)).toBe(true);
			expect(body.budget).toBe(4000);
		});
	});

	describe("GET /sessions/:id/context-graph", () => {
		test("returns 404 when session not found", async () => {
			const app = buildSessionContextRouter(makeBridge(undefined));
			const res = await app.request("/sessions/missing/context-graph");
			expect(res.status).toBe(404);
		});

		test("respects limit query param", async () => {
			const { app } = setupSession();
			await app.request("/sessions/s1/context/rebuild", { method: "POST" });
			const res = await app.request("/sessions/s1/context-graph?limit=2");
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextGraphResponse;
			expect(body.nodes.length).toBeLessThanOrEqual(2);
			expect(body.totalNodes).toBe(3);
			expect(body.truncated).toBe(true);
		});
	});
});
