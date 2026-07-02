import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionContextNode } from "@omp-deck/protocol";
import { closeDb, openDb } from "./index.ts";
import {
	getSessionContextGraph,
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
});
