/**
 * Embedded SQLite topology store.
 *
 * Uses bun:sqlite (in-process) — no server dependency.
 * Schema mirrors the deck server's session-context tables but
 * simplified for standalone use.
 */

import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as os from "node:os";
import type { TopologyNode, TopologyEdge, TopologyArtifact } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS topology_nodes (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	message_id TEXT,
	turn_index INTEGER,
	title TEXT,
	body TEXT,
	importance REAL DEFAULT 0.7,
	created_at TEXT,
	metadata_json TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON topology_nodes(session_id);

CREATE TABLE IF NOT EXISTS topology_edges (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	source_node_id TEXT NOT NULL,
	target_node_id TEXT NOT NULL,
	relation TEXT NOT NULL,
	weight REAL DEFAULT 0.5,
	metadata_json TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_edges_session ON topology_edges(session_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON topology_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON topology_edges(target_node_id);

CREATE TABLE IF NOT EXISTS topology_artifacts (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	node_id TEXT,
	kind TEXT NOT NULL,
	ref TEXT,
	label TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON topology_artifacts(session_id);

CREATE TABLE IF NOT EXISTS topology_checkpoints (
	session_id TEXT PRIMARY KEY,
	source_path TEXT,
	source_mtime_ms INTEGER,
	source_size_bytes INTEGER,
	node_count INTEGER,
	edge_count INTEGER,
	rebuilt_at TEXT
);
`;

export class TopologyStore {
	private db: Database;

	constructor(dbPath?: string) {
		const resolvedPath = dbPath ?? path.join(os.homedir(), ".omp", "agent", "topology-memory.db");
		this.db = new Database(resolvedPath, { create: true });
		this.db.exec(SCHEMA);
	}

	replaceSession(sessionId: string, nodes: TopologyNode[], edges: TopologyEdge[], artifacts: TopologyArtifact[]): void {
		const tx = this.db.transaction(() => {
			this.db.query("DELETE FROM topology_nodes WHERE session_id = ?").run(sessionId);
			this.db.query("DELETE FROM topology_edges WHERE session_id = ?").run(sessionId);
			this.db.query("DELETE FROM topology_artifacts WHERE session_id = ?").run(sessionId);

			const insertNode = this.db.query(
				"INSERT INTO topology_nodes (id, session_id, kind, message_id, turn_index, title, body, importance, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const n of nodes) {
				insertNode.run(n.id, n.sessionId, n.kind, n.messageId, n.turnIndex, n.title, n.body, n.importance, n.createdAt, JSON.stringify(n.metadata));
			}

			const insertEdge = this.db.query(
				"INSERT INTO topology_edges (id, session_id, source_node_id, target_node_id, relation, weight, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const e of edges) {
				insertEdge.run(e.id, e.sessionId, e.sourceNodeId, e.targetNodeId, e.relation, e.weight, JSON.stringify(e.metadata));
			}

			const insertArtifact = this.db.query(
				"INSERT INTO topology_artifacts (id, session_id, node_id, kind, ref, label) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const a of artifacts) {
				insertArtifact.run(a.id, a.sessionId, a.nodeId ?? null, a.kind, a.ref, a.label);
			}
		});
		tx();
	}

	getNodes(sessionId: string): TopologyNode[] {
		return this.db.query<TopologyNode, [string]>(
			"SELECT id, session_id AS sessionId, kind, message_id AS messageId, turn_index AS turnIndex, title, body, importance, created_at AS createdAt, metadata_json AS metadata FROM topology_nodes WHERE session_id = ? ORDER BY turn_index",
		).all(sessionId).map((row) => ({
			...row,
			metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata as string) : {},
		})) as TopologyNode[];
	}

	getEdges(sessionId: string): TopologyEdge[] {
		return this.db.query<TopologyEdge, [string]>(
			"SELECT id, session_id AS sessionId, source_node_id AS sourceNodeId, target_node_id AS targetNodeId, relation, weight, metadata_json AS metadata FROM topology_edges WHERE session_id = ?",
		).all(sessionId).map((row) => ({
			...row,
			metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata as string) : {},
		})) as TopologyEdge[];
	}

	getArtifacts(sessionId: string): TopologyArtifact[] {
		return this.db.query<TopologyArtifact, [string]>(
			"SELECT id, session_id AS sessionId, node_id AS nodeId, kind, ref, label FROM topology_artifacts WHERE session_id = ?",
		).all(sessionId) as TopologyArtifact[];
	}

	upsertCheckpoint(sessionId: string, sourcePath: string, mtimeMs: number, sizeBytes: number, nodeCount: number, edgeCount: number): void {
		this.db.query(
			"INSERT OR REPLACE INTO topology_checkpoints (session_id, source_path, source_mtime_ms, source_size_bytes, node_count, edge_count, rebuilt_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(sessionId, sourcePath, mtimeMs, sizeBytes, nodeCount, edgeCount, new Date().toISOString());
	}

	getCheckpoint(sessionId: string): { sourcePath: string; sourceMtimeMs: number; sourceSizeBytes: number; nodeCount: number } | null {
		return this.db.query<{
			sourcePath: string; sourceMtimeMs: number; sourceSizeBytes: number; nodeCount: number;
		}, [string]>(
			"SELECT source_path AS sourcePath, source_mtime_ms AS sourceMtimeMs, source_size_bytes AS sourceSizeBytes, node_count AS nodeCount FROM topology_checkpoints WHERE session_id = ?",
		).get(sessionId) ?? null;
	}

	isStale(sessionId: string, sourcePath: string, mtimeMs: number, sizeBytes: number): boolean {
		const cp = this.getCheckpoint(sessionId);
		if (!cp) return true;
		return cp.sourcePath !== sourcePath || cp.sourceMtimeMs !== mtimeMs || cp.sourceSizeBytes !== sizeBytes;
	}

	close(): void {
		this.db.close();
	}
}
