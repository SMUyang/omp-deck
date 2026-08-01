import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import type {
	SessionContextEdge,
	SessionContextFocusResponse,
	SessionContextGraphResponse,
	SessionContextNode,
	SessionContextPackResponse,
	SessionContextStatusResponse,
	SessionSummary,
} from "@omp-deck/protocol";

import type { AgentBridge } from "./bridge/types.ts";
import { closeDb, getDb, openDb } from "./db/index.ts";
import { getSessionContextStatus, replaceSessionContext, upsertSessionContextCheckpoint } from "./db/session-context.ts";
import { buildSessionContextRouter } from "./routes-session-context.ts";
const jsonl = [
	JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-07-31T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Run the topology context test." }], timestamp: Date.parse("2026-07-31T10:00:00.000Z") } }),
	JSON.stringify({ type: "message", id: "a-tools", parentId: "u1", timestamp: "2026-07-31T10:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "test-1", name: "bash", arguments: { command: "bun test apps/server/src/routes-session-context.test.ts" } }], stopReason: "toolUse", timestamp: Date.parse("2026-07-31T10:00:01.000Z") } }),
	JSON.stringify({ type: "message", id: "r1", parentId: "a-tools", timestamp: "2026-07-31T10:00:02.000Z", message: { role: "toolResult", toolCallId: "test-1", toolName: "bash", content: [{ type: "text", text: "39 pass\n0 fail" }], details: { exitCode: 0 }, isError: false, timestamp: Date.parse("2026-07-31T10:00:02.000Z") } }),
	JSON.stringify({ type: "message", id: "a1", parentId: "r1", timestamp: "2026-07-31T10:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "The topology context test passes." }], stopReason: "stop", timestamp: Date.parse("2026-07-31T10:00:03.000Z") } }),
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

function insertLegacyV1Context(sessionId: string, sessionFile: string, counts = { nodeCount: 2, edgeCount: 1 }): void {
	const db = getDb();
	const nodes = Array.from({ length: counts.nodeCount }, (_, index) => ({
		id: `${sessionId}-legacy-${index}`,
		sessionId,
		kind: index === 0 ? "goal" as const : "evidence" as const,
		title: `legacy ${index}`,
		body: `legacy body ${index}`,
		compressedBody: `legacy body ${index}`,
		importance: 1 - index / Math.max(1, counts.nodeCount),
		createdAt: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
		metadata: {},
	}));
	const edges = Array.from({ length: counts.edgeCount }, (_, index) => ({
		id: `${sessionId}-legacy-edge-${index}`,
		sessionId,
		sourceNodeId: nodes[index % nodes.length]!.id,
		targetNodeId: nodes[(index + 1) % nodes.length]!.id,
		relation: "verified_by" as const,
		weight: 0.8,
		metadata: {},
	}));
	replaceSessionContext({ sessionId, nodes, edges, artifacts: [] });
	const stat = fs.statSync(sessionFile);
	upsertSessionContextCheckpoint({
		sessionId,
		sourcePath: sessionFile,
		sourceMtimeMs: Math.trunc(stat.mtimeMs),
		sourceSizeBytes: stat.size,
		nodeCount: counts.nodeCount,
		edgeCount: counts.edgeCount,
		extractionSchemaVersion: 1,
		rebuiltAt: "2026-07-01T00:00:10.000Z",
	});
	const raw = db.query<{ extraction_schema_version: number }, [string]>("SELECT extraction_schema_version FROM session_context_checkpoints WHERE session_id = ?").get(sessionId);
	expect(raw?.extraction_schema_version).toBe(1);
}

function defer<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

/** Trigger rebuild and wait for it to complete (regex mode = instant). */
async function rebuildAndWait(app: Hono, id: string): Promise<void> {
	const res = await app.request(`/sessions/${id}/context/rebuild`, { method: "POST" });
	expect(res.status).toBe(202);
	return rebuildAndWaitStatus(app, id).then(() => {});
}

async function rebuildAndWaitStatus(app: Hono, id: string): Promise<SessionContextStatusResponse> {
	for (;;) {
		const statusRes = await app.request(`/sessions/${id}/context-status`);
		if (statusRes.status === 200) {
			const body = (await statusRes.json()) as SessionContextStatusResponse;
			if (body.built && !body.rebuilding) return body;
		}
		await Bun.sleep(1);
	}
}


// Force regex extraction so tests don't hit real DeepSeek API
let extractionModeBackup: string | undefined;
let embeddingEnabledBackup: string | undefined;
let dataDirBackup: string | undefined;
beforeEach(() => {
	extractionModeBackup = process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE;
	embeddingEnabledBackup = process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED;
	dataDirBackup = process.env.OMP_DECK_DATA_DIR;
	process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE = "regex";
	process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED = "0";
	process.env.OMP_DECK_DATA_DIR = tempDir();
});
afterEach(() => {
	if (extractionModeBackup !== undefined) process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE = extractionModeBackup;
	else delete process.env.OMP_DECK_TOPOLOGY_EXTRACTION_MODE;
	if (embeddingEnabledBackup !== undefined) process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED = embeddingEnabledBackup;
	else delete process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED;
	if (dataDirBackup !== undefined) process.env.OMP_DECK_DATA_DIR = dataDirBackup;
	else delete process.env.OMP_DECK_DATA_DIR;
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

		test("returns current extraction version while rebuilding and stores version 2 for a historical session", async () => {
			const { app, sessionFile } = setupPersistedSession();
			insertLegacyV1Context("persisted-s1", sessionFile);

			const res = await app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });

			expect(res.status).toBe(202);
			const body = (await res.json()) as SessionContextStatusResponse;
			expect(body.sessionId).toBe("persisted-s1");
			expect(body.rebuilding).toBe(true);
			expect(body.extractionSchemaVersion).toBe(2);
			await rebuildAndWaitStatus(app, "persisted-s1");
			const status = getSessionContextStatus("persisted-s1");
			expect(status.extractionSchemaVersion).toBe(2);
		});

		test("rejects a second rebuild while the first historical rebuild is in progress", async () => {
			const { app } = setupPersistedSession();

			const first = await app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });
			const second = await app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });

			expect(first.status).toBe(202);
			expect(second.status).toBe(409);
			expect(await second.json()).toEqual({ error: "already_rebuilding", sessionId: "persisted-s1" });
			await rebuildAndWaitStatus(app, "persisted-s1");
		});

		test("serializes concurrent historical rebuild requests before session lookup resolves", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const sessionFile = path.join(dir, "persisted-s1.jsonl");
			fs.writeFileSync(sessionFile, jsonl);
			const listGate = defer<SessionSummary[]>();
			let listCalls = 0;
			const app = buildSessionContextRouter({
				getSession: () => undefined,
				listSessions: () => {
					listCalls++;
					return listGate.promise;
				},
			} as unknown as AgentBridge);

			const firstPromise = app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });
			const secondPromise = app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });
			await Promise.resolve();

			expect(listCalls).toBe(1);
			listGate.resolve([{
				id: "persisted-s1",
				path: sessionFile,
				cwd: "/repo",
				title: "persisted-s1",
				createdAt: "2026-07-02T00:00:00.000Z",
				updatedAt: "2026-07-02T00:00:00.000Z",
				messageCount: 1,
			}]);

			const [first, second] = await Promise.all([firstPromise, secondPromise]);
			expect(first.status).toBe(202);
			expect(second.status).toBe(409);
			expect(await second.json()).toEqual({ error: "already_rebuilding", sessionId: "persisted-s1" });
			await rebuildAndWaitStatus(app, "persisted-s1");
		});

		test("releases the rebuild claim when historical session lookup fails", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			let listCalls = 0;
			const app = buildSessionContextRouter({
				getSession: () => undefined,
				listSessions: async () => {
					listCalls++;
					return [];
				},
			} as unknown as AgentBridge);

			const first = await app.request("/sessions/missing/context/rebuild", { method: "POST" });
			const second = await app.request("/sessions/missing/context/rebuild", { method: "POST" });

			expect(first.status).toBe(404);
			expect(second.status).toBe(404);
			expect(listCalls).toBe(2);
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

		test("reads a v1 checkpoint without mutating its version", async () => {
			const { app, sessionFile } = setupPersistedSession();
			insertLegacyV1Context("persisted-s1", sessionFile);

			const res = await app.request("/sessions/persisted-s1/context-status");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextStatusResponse;
			expect(body.extractionSchemaVersion).toBe(1);
			expect(getSessionContextStatus("persisted-s1").extractionSchemaVersion).toBe(1);
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

		test("reads a v1 pack without implicitly rebuilding the checkpoint", async () => {
			const { app, sessionFile } = setupPersistedSession();
			insertLegacyV1Context("persisted-s1", sessionFile);

			const res = await app.request("/sessions/persisted-s1/context-pack?q=legacy&budget=4000");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextPackResponse;
			expect(body.sessionId).toBe("persisted-s1");
			expect(body.summary).toContain("legacy body");
			expect(getSessionContextStatus("persisted-s1").extractionSchemaVersion).toBe(1);
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

		test("reads a v1 graph without implicitly rebuilding the checkpoint", async () => {
			const { app, sessionFile } = setupPersistedSession();
			insertLegacyV1Context("persisted-s1", sessionFile);

			const res = await app.request("/sessions/persisted-s1/context-graph?limit=1");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextGraphResponse;
			expect(body.nodes).toHaveLength(1);
			expect(body.totalNodes).toBe(2);
			expect(getSessionContextStatus("persisted-s1").extractionSchemaVersion).toBe(1);
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


		test("reports authoritative v2 totals and exact selected counts", async () => {
			const dir = tempDir();
			openDb({ path: path.join(dir, "deck.db") });
			const sessionFile = path.join(dir, "s-counts.jsonl");
			fs.writeFileSync(sessionFile, jsonl);
			const pairId = "pair-selected";
			const user: SessionContextNode = { id: "u-selected", sessionId: "s-counts", kind: "goal", title: "selected", body: "selected needle", compressedBody: "selected needle", importance: 1, createdAt: "", sourceMessageId: "u1", sourceTurnIndex: 1, population: "user", nodeRole: "main", origin: "user", pairId, operation: "request", purpose: "selected needle", purposeSource: "explicit_text", status: "completed", metadata: {} };
			const assistant: SessionContextNode = { id: "a-selected", sessionId: "s-counts", kind: "resolution", title: "answer", body: "answer", compressedBody: "answer", importance: 1, createdAt: "", sourceMessageId: "a1", sourceTurnIndex: 2, population: "assistant", nodeRole: "main", origin: "assistant", pairId, operation: "answer", purpose: "answer", purposeSource: "explicit_text", status: "completed", metadata: {} };
			const child: SessionContextNode = { id: "c-selected", sessionId: "s-counts", kind: "evidence", title: "test", body: "passed", compressedBody: "passed", importance: 1, createdAt: "", sourceMessageId: "t1", sourceTurnIndex: 3, population: "assistant", nodeRole: "child", origin: "tool", childType: "test", pairId, parentNodeId: assistant.id, operation: "verify", purpose: "test", purposeSource: "deterministic", status: "completed", metadata: {} };
			const unrelatedNodes = Array.from({ length: 70 }, (_, index): SessionContextNode => ({
				...child,
				id: `c-unowned-${index}`,
				pairId: `pair-unowned-${index}`,
				parentNodeId: `missing-assistant-${index}`,
				title: `unowned ${index}`,
				body: `unrelated ${index}`,
				compressedBody: `unrelated ${index}`,
				sourceMessageId: `tool-unowned-${index}`,
				sourceTurnIndex: index + 4,
			}));
			const edges: SessionContextEdge[] = [
				{ id: "answers-selected", sessionId: "s-counts", sourceNodeId: user.id, targetNodeId: assistant.id, relation: "answers", weight: 1, metadata: {} },
				{ id: "child-selected", sessionId: "s-counts", sourceNodeId: assistant.id, targetNodeId: child.id, relation: "verified_by", weight: 1, metadata: {} },
			];
			const nodes = [user, assistant, child, ...unrelatedNodes];
			replaceSessionContext({ sessionId: "s-counts", nodes, edges, artifacts: [] });
			upsertSessionContextCheckpoint({ sessionId: "s-counts", sourcePath: sessionFile, sourceMtimeMs: 1, sourceSizeBytes: 1, nodeCount: nodes.length, edgeCount: edges.length, extractionSchemaVersion: 2, rebuiltAt: "2026-08-01T00:00:00.000Z" });
			const app = buildSessionContextRouter(makeBridge({ sessionId: "s-counts", sessionFile }));

			const res = await app.request("/sessions/s-counts/context-focus?q=selected%20needle");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextFocusResponse;
			expect(body.nodeCount).toBe(nodes.length);
			expect(body.edgeCount).toBe(edges.length);
			expect(body.selectedNodeCount).toBe(3);
			expect(body.selectedEdgeCount).toBe(2);
			expect(body.truncated).toBe(true);
			const payload = JSON.parse(body.focus.match(/<session_topology_subgraph>\n(.+)\n<\/session_topology_subgraph>/)![1]!);
			expect(payload.schemaVersion).toBe(2);
			expect(payload.pairs).toHaveLength(1);
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

		test("uses checkpoint totals for bounded focus and keeps v1 checkpoint read-only", async () => {
			const { app, sessionFile } = setupPersistedSession();
			insertLegacyV1Context("persisted-s1", sessionFile, { nodeCount: 501, edgeCount: 500 });

			const res = await app.request("/sessions/persisted-s1/context-focus?q=legacy");

			expect(res.status).toBe(200);
			const body = (await res.json()) as SessionContextFocusResponse;
			expect(body.nodeCount).toBe(501);
			expect(body.edgeCount).toBe(500);
			expect(body.selectedNodeCount).toBeUndefined();
			expect(body.selectedEdgeCount).toBeUndefined();
			expect(body.truncated).toBe(true);
			expect(getSessionContextStatus("persisted-s1").extractionSchemaVersion).toBe(1);
		});

		test("returns 404 when session is missing", async () => {
			const app = buildSessionContextRouter(makeBridge(undefined));
			const res = await app.request("/sessions/missing/context-focus?q=context");
			expect(res.status).toBe(404);
		});
	});
});
