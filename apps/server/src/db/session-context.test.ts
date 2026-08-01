import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionContextNode, SessionContextStatusResponse } from "@omp-deck/protocol";
import { closeDb, getDb, openDb } from "./index.ts";
import {
	getCompleteSessionContextGraph,
	getSessionContextStatus,
	getSessionContextGraph,
	insertSessionContextNodes,
	replaceSessionContext,
	upsertSessionContextCheckpoint,
} from "./session-context.ts";

const tempDirs: string[] = [];

function openTempDeckDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-context-db-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "deck.db");
	openDb({ path: dbPath });
	return dbPath;
}

afterEach(() => {
	closeDb();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function node(id: string, kind: SessionContextNode["kind"], title: string): SessionContextNode {
	return {
		id,
		sessionId: "s1",
		kind,
		title,
		body: title,
		compressedBody: title,
		importance: 0.7,
		createdAt: "2026-07-02T00:00:00.000Z",
		metadata: { source: "test" },
	};
}

function v2Node(id = "s1:entry:u1:message", sessionId = "s1"): SessionContextNode {
	return {
		id,
		sessionId,
		kind: "goal",
		title: "Keep start mode alive",
		body: "start mode must remain alive in the background",
		compressedBody: "start mode must remain alive in the background",
		importance: 0.7,
		createdAt: "2026-07-31T00:00:00.000Z",
		sourceMessageId: "u1",
		sourceTurnIndex: 1,
		population: "user",
		nodeRole: "main",
		origin: "user",
		pairId: `${sessionId}:pair:u1`,
		operation: "request",
		operationDetail: "fix_background_start",
		purpose: "让 start 模式保持后台运行",
		purposeSource: "explicit_text",
		refinedPurpose: "确保后台服务持续存活",
		refinement: { model: "fast/model", promptVersion: "purpose-v1" },
		status: "completed",
		metadata: {},
	};
}

describe("session context store", () => {
	test("replaces nodes edges and artifacts for a session", () => {
		openTempDeckDb();

		replaceSessionContext({
			sessionId: "s1",
			nodes: [node("n1", "goal", "build context pack"), node("n2", "evidence", "tests pass")],
			edges: [{
				id: "e1",
				sessionId: "s1",
				sourceNodeId: "n1",
				targetNodeId: "n2",
				relation: "verified_by",
				weight: 1,
				metadata: {},
			}],
			artifacts: [{
				id: "a1",
				sessionId: "s1",
				nodeId: "n2",
				kind: "test",
				ref: "bun test apps/server/src/session-context.test.ts",
				label: "session context tests",
				metadata: {},
			}],
		});

		let graph = getSessionContextGraph("s1", 50);
		expect(graph.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.artifacts).toHaveLength(1);

		replaceSessionContext({ sessionId: "s1", nodes: [node("n3", "issue", "old graph removed")], edges: [], artifacts: [] });
		graph = getSessionContextGraph("s1", 50);
		expect(graph.nodes.map((n) => n.id)).toEqual(["n3"]);
		expect(graph.edges).toHaveLength(0);
		expect(graph.artifacts).toHaveLength(0);
	});

	test("round-trips v2 semantics and answers through replace", () => {
		openTempDeckDb();
		const user = v2Node();
		const assistant = {
			...node("a1", "resolution", "start mode stays alive"),
			sessionId: "s1",
			sourceTurnIndex: 2,
		};

		replaceSessionContext({
			sessionId: "s1",
			nodes: [user, assistant],
			edges: [{
				id: "s1:answers:a1:u1",
				sessionId: "s1",
				sourceNodeId: "a1",
				targetNodeId: user.id,
				relation: "answers",
				weight: 1,
				evidenceMessageId: "a1",
				metadata: {},
			}],
			artifacts: [],
		});

		const graph = getSessionContextGraph("s1", 50);
		expect(graph.nodes.find((candidate) => candidate.id === user.id)).toEqual(user);
		expect(graph.edges).toEqual([{
			id: "s1:answers:a1:u1",
			sessionId: "s1",
			sourceNodeId: "a1",
			targetNodeId: user.id,
			relation: "answers",
			weight: 1,
			evidenceMessageId: "a1",
			metadata: {},
		}]);
	});

	test("round-trips every v2 semantic field through incremental insert", () => {
		openTempDeckDb();
		const user = v2Node("s2:entry:u1:message", "s2");

		insertSessionContextNodes({ sessionId: "s2", nodes: [user], edges: [], artifacts: [] });

		expect(getSessionContextGraph("s2", 50).nodes).toEqual([user]);
	});

	test("preserves explicit null purpose for v2 nodes but omits it for legacy nodes", () => {
		openTempDeckDb();
		const v2WithoutPurpose: SessionContextNode = {
			...v2Node("s-null:entry:u1:message", "s-null"),
			purpose: null,
			purposeSource: "unclassified",
		};
		const legacy = {
			...node("legacy", "goal", "legacy goal"),
			sessionId: "s-null",
		};

		replaceSessionContext({ sessionId: "s-null", nodes: [v2WithoutPurpose, legacy], edges: [], artifacts: [] });

		const graph = getSessionContextGraph("s-null", 50);
		const storedV2 = graph.nodes.find((candidate) => candidate.id === v2WithoutPurpose.id);
		const storedLegacy = graph.nodes.find((candidate) => candidate.id === legacy.id);
		expect(storedV2).toHaveProperty("purpose", null);
		expect(storedLegacy).not.toHaveProperty("purpose");
	});

	test("complete graph returns all nodes and edges without changing bounded reads", () => {
		openTempDeckDb();
		const earlyUser = v2Node("s-large:entry:u1:message", "s-large");
		const evidenceNodes = Array.from({ length: 650 }, (_, index) => ({
			...node(`e${index}`, "evidence", `late evidence ${index}`),
			sessionId: "s-large",
			sourceTurnIndex: index + 2,
			importance: 1,
			createdAt: `2026-07-31T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
		}));
		const edges = evidenceNodes.map((evidence, index) => ({
			id: `edge-${index}`,
			sessionId: "s-large",
			sourceNodeId: evidence.id,
			targetNodeId: earlyUser.id,
			relation: "depends_on" as const,
			weight: 1,
			metadata: {},
		}));

		replaceSessionContext({ sessionId: "s-large", nodes: [earlyUser, ...evidenceNodes], edges, artifacts: [] });

		const bounded = getSessionContextGraph("s-large", 500);
		expect(bounded.nodes).toHaveLength(500);
		expect(bounded.nodes.some((candidate) => candidate.id === earlyUser.id)).toBe(false);
		expect(bounded.truncated).toBe(true);
		expect(bounded.totalNodes).toBe(651);

		const complete = getCompleteSessionContextGraph("s-large");
		expect(complete.nodes).toHaveLength(651);
		expect(complete.nodes[0]?.id).toBe(earlyUser.id);
		expect(complete.edges).toHaveLength(650);
		expect(complete.artifacts).toEqual([]);
		expect(complete.truncated).toBe(false);
		expect(complete.totalNodes).toBe(651);
	});

	test("redacts direct replaceSessionContext writes", () => {
		openTempDeckDb();
		const secret = "sk-proj-Ab1cDe2fGh3iJk4lMn5oPq6rSt7uVw8xYz0";
		replaceSessionContext({
			sessionId: "s_write_redact",
			nodes: [{
				...node("n-write", "user_intent", `configure ${secret}`),
				sessionId: "s_write_redact",
				body: `body ${secret}`,
				compressedBody: `compressed ${secret}`,
			}],
			edges: [],
			artifacts: [{
				id: "a-write",
				sessionId: "s_write_redact",
				nodeId: "n-write",
				kind: "file",
				ref: `/tmp/${secret}.txt`,
				label: `artifact ${secret}`,
				metadata: {},
			}],
		});

		const graph = getSessionContextGraph("s_write_redact", 50);
		const combined = [
			...graph.nodes.flatMap((n) => [n.title, n.body, n.compressedBody]),
			...graph.artifacts.flatMap((a) => [a.ref, a.label]),
		].join("\n");
		expect(combined).not.toContain(secret);
		expect(combined).toContain("[REDACTED]");
	});

	test("records rebuild checkpoint metadata", () => {
		openTempDeckDb();

		upsertSessionContextCheckpoint({
			sessionId: "s1",
			sourcePath: "/tmp/session.jsonl",
			sourceMtimeMs: 123,
			sourceSizeBytes: 456,
			nodeCount: 2,
			edgeCount: 1,
			rebuiltAt: "2026-07-02T00:00:00.000Z",
		});

		const graph = getSessionContextGraph("s1", 50);
		expect(graph.totalNodes).toBe(0);
	});
	test("clamps limit=0 to lower bound 1 and marks truncated", () => {
		openTempDeckDb();

		replaceSessionContext({
			sessionId: "s1",
			nodes: [node("n1", "goal", "alpha"), node("n2", "goal", "beta")],
			edges: [],
			artifacts: [],
		});

		const graph = getSessionContextGraph("s1", 0);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.truncated).toBe(true);
		expect(graph.totalNodes).toBe(2);
	});

	test("filters artifacts to visible nodes but keeps session-level artifacts", () => {
		openTempDeckDb();

		replaceSessionContext({
			sessionId: "s1",
			nodes: [node("n1", "goal", "alpha"), node("n2", "goal", "beta")],
			edges: [],
			artifacts: [
				{
					id: "a-attached",
					sessionId: "s1",
					nodeId: "n2",
					kind: "test",
					ref: "attached",
					label: "attached artifact",
					metadata: {},
				},
				{
					id: "a-session",
					sessionId: "s1",
					kind: "test",
					ref: "session-level",
					label: "session-level artifact",
					metadata: {},
				},
			],
		});

		// limit=1 picks only n1 (highest importance first); n2 is omitted.
		const graph = getSessionContextGraph("s1", 1);
		expect(graph.nodes.map((n) => n.id)).toEqual(["n1"]);
		expect(graph.artifacts.map((a) => a.id)).toEqual(["a-session"]);
	});

	test("redacts legacy raw rows on graph read", () => {
		openTempDeckDb();
		const secret = "sk-proj-Ab1cDe2fGh3iJk4lMn5oPq6rSt7uVw8xYz0";
		const db = getDb();
		db.prepare(`
			INSERT INTO session_context_nodes (
				id, session_id, kind, title, body, compressed_body,
				source_message_id, source_turn_index, importance, created_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"n-legacy",
			"s_legacy",
			"user_intent",
			`configure key ${secret}`,
			`body has ${secret}`,
			`compressed ${secret}`,
			"m1",
			1,
			1,
			"2026-07-02T00:00:00.000Z",
			"{}",
		);
		db.prepare(`
			INSERT INTO session_context_artifacts (id, session_id, node_id, kind, ref, label, metadata_json)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			"a-legacy",
			"s_legacy",
			"n-legacy",
			"file",
			`/tmp/${secret}.txt`,
			`file ${secret}`,
			"{}",
		);

		const graph = getSessionContextGraph("s_legacy", 50);
		const combined = [
			...graph.nodes.flatMap((n) => [n.title, n.body, n.compressedBody]),
			...graph.artifacts.flatMap((a) => [a.ref, a.label]),
		].join("\n");
		expect(combined).not.toContain(secret);
		expect(combined).toContain("[REDACTED]");
	});
});

describe("session context status", () => {
	test("returns unbuilt status when a session has no checkpoint", () => {
		openTempDeckDb();

		const status = getSessionContextStatus("s-missing");

		expect(status).toEqual<SessionContextStatusResponse>({
			sessionId: "s-missing",
			built: false,
			nodeCount: 0,
			edgeCount: 0,
		});
	});

	test("returns checkpoint counts for built session context", () => {
		openTempDeckDb();

		upsertSessionContextCheckpoint({
			sessionId: "s1",
			sourcePath: "/tmp/s1.jsonl",
			sourceMtimeMs: 1234,
			sourceSizeBytes: 5678,
			nodeCount: 12,
			edgeCount: 3,
			extractionSchemaVersion: 2,
			rebuiltAt: "2026-07-02T00:00:00.000Z",
		});

		expect(getSessionContextStatus("s1")).toEqual<SessionContextStatusResponse>({
			sessionId: "s1",
			built: true,
			nodeCount: 12,
			edgeCount: 3,
			rebuiltAt: "2026-07-02T00:00:00.000Z",
			sourceMtimeMs: 1234,
			sourceSizeBytes: 5678,
			extractionSchemaVersion: 2,
		});
	});
});
