import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import type {
	SessionContextFocusResponse,
	SessionContextGraphResponse,
	SessionContextPackResponse,
	SessionContextStatusResponse,
	SessionSummary,
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
function makeBridge(handle: StubHandle | undefined, persisted: Array<string | SessionSummary> = []): AgentBridge {
	return {
		getSession: () => handle,
		listSessions: async () => persisted.map((entry) => {
			if (typeof entry === "string") {
				return {
					id: entry,
					path: `/tmp/${entry}.jsonl`,
					cwd: "/repo",
					title: entry,
					createdAt: "2026-07-02T00:00:00.000Z",
					updatedAt: "2026-07-02T00:00:00.000Z",
					messageCount: 1,
				};
			}
			return entry;
		}),
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

function setupPersistedSession(): { app: Hono; sessionFile: string } {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });
	const sessionFile = path.join(dir, "persisted-s1.jsonl");
	fs.writeFileSync(sessionFile, jsonl);
	const app = buildSessionContextRouter(makeBridge(undefined, [{
		id: "persisted-s1",
		path: sessionFile,
		cwd: "/repo",
		title: "persisted-s1",
		createdAt: "2026-07-02T00:00:00.000Z",
		updatedAt: "2026-07-02T00:00:00.000Z",
		messageCount: 1,
	}]));
	return { app, sessionFile };
}

/** Trigger rebuild and wait for it to complete (regex mode = instant). */
async function rebuildAndWait(app: Hono, id: string): Promise<void> {
	const res = await app.request(`/sessions/${id}/context/rebuild`, { method: "POST" });
	expect(res.status).toBe(202);
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const statusRes = await app.request(`/sessions/${id}/context-status`);
		if (statusRes.status === 200) {
			const body = (await statusRes.json()) as SessionContextStatusResponse;
			if (body.built && !body.rebuilding) return;
		}
		await Bun.sleep(20);
	}
	throw new Error(`rebuild did not complete for ${id} within 5s`);
}

// Force regex extraction so tests don't hit real DeepSeek API
let extractionModeBackup: string | undefined;
beforeEach(() => {
	process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE = "regex";
});
afterEach(() => {
	if (extractionModeBackup) process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE = extractionModeBackup;
	else delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE;
});

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

		test("returns retryable 409 when session file is missing", async () => {
			const missingFile = path.join(tempDir(), "not-created.jsonl");
			const app = buildSessionContextRouter(makeBridge({ sessionId: "s1", sessionFile: missingFile }));
			const res = await app.request("/sessions/s1/context/rebuild", { method: "POST" });
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({ error: "session_file_not_ready", retryable: true });
		});

		test("returns 202 and rebuilds async when session has a file", async () => {
			const { app, sessionFile } = setupSession();
			const res = await app.request("/sessions/s1/context/rebuild", { method: "POST" });
			expect(res.status).toBe(202);
			const body = (await res.json()) as { sessionId: string; status: string; sourcePath: string };
			expect(body.sessionId).toBe("s1");
			expect(body.status).toBe("rebuilding");
			expect(body.sourcePath).toBe(sessionFile);
		// Wait for async rebuild to settle (poll status, don't re-trigger)
		for (let i = 0; i < 100; i++) {
			const sr = await app.request("/sessions/s1/context-status");
			const sb = (await sr.json()) as SessionContextStatusResponse;
			if (sb.built && !sb.rebuilding) break;
			await Bun.sleep(20);
		}
		});

		test("returns 202 for persisted session and rebuilds async", async () => {
			const { app, sessionFile } = setupPersistedSession();
			const res = await app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });
			expect(res.status).toBe(202);
			const body = (await res.json()) as { sessionId: string; status: string; sourcePath: string };
			expect(body.sessionId).toBe("persisted-s1");
			expect(body.status).toBe("rebuilding");
			expect(body.sourcePath).toBe(sessionFile);
		for (let i = 0; i < 100; i++) {
			const sr = await app.request("/sessions/persisted-s1/context-status");
			const sb = (await sr.json()) as SessionContextStatusResponse;
			if (sb.built && !sb.rebuilding) break;
			await Bun.sleep(20);
		}
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
			await rebuildAndWait(app, "s1");

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
			await rebuildAndWait(app, "s1");
			const res = await app.request("/sessions/s1/context-pack?q=context&budget=4000");
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextPackResponse;
			expect(body.sessionId).toBe("s1");
			expect(typeof body.summary).toBe("string");
			expect(Array.isArray(body.goals)).toBe(true);
			expect(body.budget).toBe(4000);
		});

		test("returns pack for persisted session after rebuild", async () => {
			const { app } = setupPersistedSession();
			await rebuildAndWait(app, "persisted-s1");
			const res = await app.request("/sessions/persisted-s1/context-pack?q=context&budget=4000");
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextPackResponse;
			expect(body.sessionId).toBe("persisted-s1");
			expect(body.query).toBe("context");
			expect(body.budget).toBe(4000);
			expect(Array.isArray(body.goals)).toBe(true);
			expect(typeof body.summary).toBe("string");
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
			await rebuildAndWait(app, "s1");
			const res = await app.request("/sessions/s1/context-graph?limit=2");
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextGraphResponse;
			expect(body.nodes.length).toBeLessThanOrEqual(2);
			expect(body.totalNodes).toBe(3);
			expect(body.truncated).toBe(true);
		});

		test("returns graph for persisted session after rebuild with limit", async () => {
			const { app } = setupPersistedSession();
			await rebuildAndWait(app, "persisted-s1");
			const res = await app.request("/sessions/persisted-s1/context-graph?limit=2");
			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextGraphResponse;
			expect(body.sessionId).toBe("persisted-s1");
			expect(body.nodes.length).toBeLessThanOrEqual(2);
			expect(body.totalNodes).toBe(3);
			expect(body.truncated).toBe(true);
		});
	});

	describe("GET /sessions/:id/context-focus", () => {
		test("returns rendered clean topology focus for active session after rebuild", async () => {
			const { app } = setupSession();
			await rebuildAndWait(app, "s1");

			const res = await app.request("/sessions/s1/context-focus?q=context&contextPercent=7");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextFocusResponse;
			expect(body.sessionId).toBe("s1");
			expect(body.query).toBe("context");
			expect(body.focus).toContain("<session_topology_subgraph>");
			expect(body.focus).toContain('"query":"context"');
			expect(body.nodeCount).toBeGreaterThan(0);
			expect(body.edgeCount).toBeGreaterThanOrEqual(0);
			expect(body.emptyReason).toBeUndefined();
			expect(body.focus).not.toContain('"importance"');
			expect(body.focus).not.toContain('"weight"');
			expect(body.focus).not.toContain('"confidence"');
			expect(body.focus).not.toContain('"relevance"');
		});

		test("returns rendered focus for persisted session after rebuild", async () => {
			const { app } = setupPersistedSession();
			await rebuildAndWait(app, "persisted-s1");

			const res = await app.request("/sessions/persisted-s1/context-focus?q=memory");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextFocusResponse;
			expect(body.sessionId).toBe("persisted-s1");
			expect(body.query).toBe("memory");
			expect(body.focus).toContain("<session_topology_subgraph>");
		});

		test("returns empty focus for existing unbuilt session", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const app = buildSessionContextRouter(makeBridge(undefined, ["persisted-s1"]));

			const res = await app.request("/sessions/persisted-s1/context-focus?q=context");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextFocusResponse;
			expect(body).toEqual({
				sessionId: "persisted-s1",
				query: "context",
				focus: "",
				nodeCount: 0,
				edgeCount: 0,
				truncated: false,
				emptyReason: "session_not_built",
			});
		});

		test("returns 404 when session is missing", async () => {
			const app = buildSessionContextRouter(makeBridge(undefined));
			const res = await app.request("/sessions/missing/context-focus?q=context");
			expect(res.status).toBe(404);
		});
	});
});
