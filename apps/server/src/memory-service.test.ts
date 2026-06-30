import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { findMnemopiDbs, getMemoryGraph, getMemoryStatus, searchMemories } from "./memory-service.ts";

const tempDirs: string[] = [];

function makeTempAgentDir(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
	tempDirs.push(tmp);
	// Create the mnemopi directory structure
	fs.mkdirSync(path.join(tmp, "memories", "mnemopi"), { recursive: true });
	return tmp;
}

afterAll(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});


function createTestDb(dbPath: string): void {
	const { Database } = require("bun:sqlite");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.run(`
		CREATE TABLE working_memory (
			id TEXT PRIMARY KEY,
			content TEXT,
			source TEXT,
			timestamp TEXT,
			importance REAL,
			memory_type TEXT,
			recall_count INTEGER,
			superseded_by TEXT,
			created_at TEXT
		)
	`);
	db.run(`
		CREATE VIRTUAL TABLE fts_working USING fts5(id, content)
	`);
	db.run(`
		CREATE TABLE episodic_memory (id TEXT)
	`);
	db.run(`
		CREATE TABLE facts (fact_id TEXT)
	`);
	db.run(`
		CREATE TABLE memory_embeddings (memory_id TEXT)
	`);
	db.run(`
		CREATE TABLE graph_edges (id TEXT)
	`);
	db.run(`INSERT INTO working_memory VALUES ('m1', 'ZMK keyboard config', 'test', '2026-01-01', 0.8, 'fact', 3, NULL, '2026-01-01')`);
	db.run(`INSERT INTO fts_working VALUES ('m1', 'ZMK keyboard config')`);
	db.run(`INSERT INTO working_memory VALUES ('m2', 'yabai window manager', 'test', '2026-01-02', 0.6, 'episode', 1, NULL, '2026-01-02')`);
	db.run(`INSERT INTO fts_working VALUES ('m2', 'yabai window manager')`);
	db.close();
}

function createGraphTestDb(dbPath: string): void {
	createTestDb(dbPath);
	const { Database } = require("bun:sqlite");
	const db = new Database(dbPath);
	db.run(`INSERT INTO working_memory VALUES ('m3', 'ZMK superseded revision', 'test', '2026-01-03', 0.9, 'fact', 0, 'm1', '2026-01-03')`);
	db.run(`INSERT INTO fts_working VALUES ('m3', 'ZMK superseded revision')`);
	db.close();
}

describe("memory-service", () => {
	test("reports unavailable when mnemopi dir does not exist", () => {
		const status = getMemoryStatus("/nonexistent/path");
		expect(status.available).toBe(false);
		expect(status.banks).toHaveLength(0);
	});

	test("finds bank DBs and reports counts", () => {
		const agentDir = makeTempAgentDir();
		createTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "test-bank", "mnemopi.db"));

		const dbs = findMnemopiDbs(agentDir);
		expect(dbs).toHaveLength(1);

		const status = getMemoryStatus(agentDir);
		expect(status.available).toBe(true);
		expect(status.banks).toHaveLength(1);
		const bank = status.banks[0];
		expect(bank).toBeDefined();
		if (!bank) throw new Error("expected first bank");
		expect(bank.bank).toBe("test-bank");
		expect(bank.workingCount).toBe(2);
		expect(status.totalWorking).toBe(2);
	});

	test("FTS search finds matching memories", () => {
		const agentDir = makeTempAgentDir();
		createTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db"));

		const { items } = searchMemories(agentDir, "keyboard");
		expect(items).toHaveLength(1);
		const first = items[0];
		expect(first).toBeDefined();
		if (!first) throw new Error("expected first memory");
		expect(first.id).toBe("m1");
		expect(first.content).toContain("ZMK");
		expect(first.bank).toBe("proj");
	});

	test("empty query returns all memories sorted by importance", () => {
		const agentDir = makeTempAgentDir();
		createTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db"));

		const { items } = searchMemories(agentDir, "");
		expect(items).toHaveLength(2);
		const first = items[0];
		const second = items[1];
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) throw new Error("expected two memories");
		expect(first.importance).toBeGreaterThanOrEqual(second.importance ?? 0);
	});

	test("search truncates very large memory bodies", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		const longContent = "needle " + "x".repeat(5000);
		db.run(`INSERT INTO working_memory VALUES ('m3', ?, 'test', '2026-01-03', 0.9, 'episode', 0, NULL, '2026-01-03')`, longContent);
		db.run(`INSERT INTO fts_working VALUES ('m3', ?)`, longContent);
		db.close();

		const { items } = searchMemories(agentDir, "needle");
		const first = items[0];
		expect(first).toBeDefined();
		if (!first) throw new Error("expected first memory");
		expect(first.id).toBe("m3");
		expect(first.content.length).toBeLessThan(5000);
		expect(first.contentTruncated).toBe(true);
	});

	test("builds a bounded memory graph from working memory and superseded links", () => {
		const agentDir = makeTempAgentDir();
		createGraphTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db"));

		const graph = getMemoryGraph(agentDir, { limit: 10 });

		expect(graph.nodes).toHaveLength(3);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]).toMatchObject({ source: "proj:m3", target: "proj:m1", relation: "supersedes", bank: "proj" });
		expect(graph.nodes[0]?.bank).toBe("proj");
		expect(graph.nodes[0]?.kind).toBe("working");
		expect(graph.truncated).toBe(false);
		expect(graph.totalNodes).toBe(3);
	});

	test("filters memory graph by bank and query", () => {
		const agentDir = makeTempAgentDir();
		createGraphTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db"));
		createGraphTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "other", "mnemopi.db"));

		const graph = getMemoryGraph(agentDir, { bank: "proj", query: "revision", limit: 10 });

		expect(graph.nodes.map((node) => node.id)).toEqual(["proj:m3"]);
		expect(graph.edges).toHaveLength(0);
		expect(graph.totalNodes).toBe(1);
	});

	test("query graph excludes unrelated derived fact and episodic nodes", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`DROP TABLE facts`);
		db.run(`CREATE TABLE facts (fact_id TEXT, source_msg_id TEXT, subject TEXT, predicate TEXT, object TEXT, confidence REAL, timestamp TEXT)`);
		db.run(`INSERT INTO facts VALUES ('fact-yabai', 'm2', 'window manager', 'is', 'yabai', 0.7, '2026-01-04')`);
		db.run(`DROP TABLE episodic_memory`);
		db.run(`CREATE TABLE episodic_memory (id TEXT, content TEXT, summary_of TEXT, importance REAL, timestamp TEXT)`);
		db.run(`INSERT INTO episodic_memory VALUES ('ep-yabai', 'window manager summary', 'm2', 0.6, '2026-01-05')`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", query: "keyboard", limit: 10 });

		expect(graph.nodes.map((node) => node.id)).toEqual(["proj:m1"]);
		expect(graph.edges).toHaveLength(0);
		expect(graph.totalNodes).toBe(1);
	});

	test("reads graph_edges when source target columns are available", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createGraphTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`DROP TABLE graph_edges`);
		db.run(`CREATE TABLE graph_edges (source_id TEXT, target_id TEXT, relationship TEXT, weight REAL)`);
		db.run(`INSERT INTO graph_edges VALUES ('m1', 'm2', 'related', 0.42)`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		expect(graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "proj:m1", target: "proj:m2", relation: "related", bank: "proj", weight: 0.42 }),
		]));
	});

	test("includes weighted graph_edges that point to episodic and fact nodes", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`INSERT INTO episodic_memory VALUES ('ep1')`);
		db.run(`INSERT INTO facts VALUES ('fact1')`);
		db.run(`DROP TABLE graph_edges`);
		db.run(`CREATE TABLE graph_edges (source TEXT, target TEXT, edge_type TEXT, weight REAL)`);
		db.run(`INSERT INTO graph_edges VALUES ('m1', 'ep1', 'ctx', 0.75)`);
		db.run(`INSERT INTO graph_edges VALUES ('ep1', 'fact1', 'rel', 0.5)`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		expect(graph.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "proj:ep1", kind: "episodic" }),
			expect.objectContaining({ id: "proj:fact1", kind: "fact" }),
		]));
		expect(graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "proj:m1", target: "proj:ep1", relation: "ctx", weight: 0.75 }),
			expect.objectContaining({ source: "proj:ep1", target: "proj:fact1", relation: "rel", weight: 0.5 }),
		]));
	});

	test("derives edges from episodic summary_of", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`DROP TABLE episodic_memory`);
		db.run(`CREATE TABLE episodic_memory (id TEXT, content TEXT, summary_of TEXT, importance REAL, timestamp TEXT)`);
		db.run(`INSERT INTO episodic_memory VALUES ('ep1', 'consolidated summary', 'm1,m2', 0.6, '2026-01-03')`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		expect(graph.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "proj:ep1", kind: "episodic" }),
		]));
		expect(graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "proj:ep1", target: "proj:m1", relation: "summarizes" }),
			expect.objectContaining({ source: "proj:ep1", target: "proj:m2", relation: "summarizes" }),
		]));
	});

	test("derives edges from facts source_msg_id", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`DROP TABLE facts`);
		db.run(`CREATE TABLE facts (fact_id TEXT, source_msg_id TEXT, subject TEXT, predicate TEXT, object TEXT, confidence REAL, timestamp TEXT)`);
		db.run(`INSERT INTO facts VALUES ('fact1', 'm1', 'keyboard', 'is', 'ZMK', 0.7, '2026-01-04')`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		expect(graph.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "proj:fact1", kind: "fact" }),
		]));
		expect(graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "proj:fact1", target: "proj:m1", relation: "extracted_from" }),
		]));
	});

	test("caps graph_edges rows before filtering", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`DROP TABLE graph_edges`);
		db.run(`CREATE TABLE graph_edges (source_id TEXT, target_id TEXT, relationship TEXT)`);
		for (let i = 0; i < 600; i += 1) db.run(`INSERT INTO graph_edges VALUES ('m1', 'm2', 'related')`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		expect(graph.edges).toHaveLength(500);
	});

	test("truncates memory graph nodes at the requested limit", () => {
		const agentDir = makeTempAgentDir();
		createGraphTestDb(path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db"));

		const graph = getMemoryGraph(agentDir, { limit: 2 });

		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source) && graph.nodes.some((node) => node.id === edge.target))).toBe(true);
		expect(graph.truncated).toBe(true);
		expect(graph.totalNodes).toBe(3);
	});
	test("derives similar edges from embedding cosine similarity", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		// Add m3 to working_memory so it's a graph node with an orthogonal embedding
		db.run(`INSERT INTO working_memory VALUES ('m3', 'unrelated content', 'test', '2026-01-03', 0.5, 'episode', 0, NULL, '2026-01-03')`);
		db.run(`INSERT INTO fts_working VALUES ('m3', 'unrelated content')`);
		// Recreate memory_embeddings with embedding_json column
		db.run(`DROP TABLE memory_embeddings`);
		db.run(`CREATE TABLE memory_embeddings (memory_id TEXT, embedding_json TEXT)`);
		// m1 and m2: identical vectors (cosine similarity = 1.0, well above 0.75)
		const identical = JSON.stringify([1, 0, 0, 0]);
		db.run(`INSERT INTO memory_embeddings VALUES ('m1', ?)`, identical);
		db.run(`INSERT INTO memory_embeddings VALUES ('m2', ?)`, identical);
		// m3: orthogonal vector (cosine similarity = 0.0, below threshold)
		db.run(`INSERT INTO memory_embeddings VALUES ('m3', ?)`, JSON.stringify([0, 1, 0, 0]));
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		const similarEdges = graph.edges.filter((e) => e.relation === "similar");
		// Only m1↔m2 should be connected (similarity 1.0 > 0.75)
		expect(similarEdges).toHaveLength(1);
		expect(similarEdges[0]).toMatchObject({ source: "proj:m1", target: "proj:m2", relation: "similar" });
		expect(similarEdges[0]?.weight).toBeCloseTo(1.0);
		// m3 must not participate in any similar edge
		expect(similarEdges.every((e) => e.source !== "proj:m3" && e.target !== "proj:m3")).toBe(true);
	});

	test("derives same_session edges from working_memory session_id", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		db.run(`
			CREATE TABLE working_memory (
				id TEXT PRIMARY KEY, content TEXT, source TEXT, timestamp TEXT,
				importance REAL, memory_type TEXT, recall_count INTEGER,
				superseded_by TEXT, created_at TEXT, session_id TEXT
			)`);
		db.run(`CREATE VIRTUAL TABLE fts_working USING fts5(id, content)`);
		db.run(`CREATE TABLE episodic_memory (id TEXT)`);
		db.run(`CREATE TABLE facts (fact_id TEXT)`);
		db.run(`CREATE TABLE memory_embeddings (memory_id TEXT)`);
		db.run(`CREATE TABLE graph_edges (id TEXT)`);
		// Three memories sharing session-A
		db.run(`INSERT INTO working_memory VALUES ('m1', 'alpha', 's', '2026-01-01', 0.8, 'fact', 0, NULL, '2026-01-01', 'session-A')`);
		db.run(`INSERT INTO fts_working VALUES ('m1', 'alpha')`);
		db.run(`INSERT INTO working_memory VALUES ('m2', 'beta', 's', '2026-01-02', 0.7, 'episode', 0, NULL, '2026-01-02', 'session-A')`);
		db.run(`INSERT INTO fts_working VALUES ('m2', 'beta')`);
		db.run(`INSERT INTO working_memory VALUES ('m3', 'gamma', 's', '2026-01-03', 0.6, 'fact', 0, NULL, '2026-01-03', 'session-A')`);
		db.run(`INSERT INTO fts_working VALUES ('m3', 'gamma')`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		const sessionEdges = graph.edges.filter((e) => e.relation === "same_session");
		// 3 members in a chain → 2 edges (well within cap of 5)
		expect(sessionEdges).toHaveLength(2);
		expect(sessionEdges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: "proj:m1", target: "proj:m2", relation: "same_session" }),
			expect.objectContaining({ source: "proj:m2", target: "proj:m3", relation: "same_session" }),
		]));
		// Weight should be in the 0.2–0.3 range
		for (const edge of sessionEdges) {
			expect(edge.weight).toBeGreaterThanOrEqual(0.2);
			expect(edge.weight).toBeLessThanOrEqual(0.3);
		}
	});

	test("derives shares_entity edges from triples entity overlap", () => {
		const agentDir = makeTempAgentDir();
		const dbPath = path.join(agentDir, "memories", "mnemopi", "banks", "proj", "mnemopi.db");
		createTestDb(dbPath);
		const { Database } = require("bun:sqlite");
		const db = new Database(dbPath);
		// Two triples with same subject from different source memories
		db.run(`CREATE TABLE triples (subject TEXT, predicate TEXT, object TEXT, source TEXT, confidence REAL)`);
		db.run(`INSERT INTO triples VALUES ('keyboard', 'is', 'ZMK', 'm1', 0.8)`);
		db.run(`INSERT INTO triples VALUES ('keyboard', 'relates_to', 'yabai', 'm2', 0.6)`);
		// A triple with a different subject (should not create cross-subject edges)
		db.run(`INSERT INTO triples VALUES ('mouse', 'is', 'logitech', 'm1', 0.9)`);
		db.close();

		const graph = getMemoryGraph(agentDir, { bank: "proj", limit: 10 });

		const entityEdges = graph.edges.filter((e) => e.relation === "shares_entity");
		// Only m1 and m2 share subject 'keyboard' → 1 edge
		expect(entityEdges).toHaveLength(1);
		expect(entityEdges[0]).toMatchObject({ source: "proj:m1", target: "proj:m2", relation: "shares_entity" });
		// Weight is the minimum confidence of the two triples
		expect(entityEdges[0]?.weight).toBeCloseTo(0.6);
	});
});
