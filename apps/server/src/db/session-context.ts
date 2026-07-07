import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
	SessionContextStatusResponse,
} from "@omp-deck/protocol";

import { getDb } from "./index.ts";
import { redactSensitiveText } from "../redaction.ts";

interface NodeRow {
	id: string;
	session_id: string;
	kind: SessionContextNode["kind"];
	title: string;
	body: string;
	compressed_body: string;
	source_message_id: string | null;
	source_turn_index: number | null;
	importance: number;
	created_at: string;
	metadata_json: string;
}

interface EdgeRow {
	id: string;
	session_id: string;
	source_node_id: string;
	target_node_id: string;
	relation: SessionContextEdge["relation"];
	weight: number;
	evidence_message_id: string | null;
	metadata_json: string;
}

interface ArtifactRow {
	id: string;
	session_id: string;
	node_id: string | null;
	kind: SessionContextArtifact["kind"];
	ref: string;
	label: string;
	metadata_json: string;
}

interface CheckpointRow {
	session_id: string;
	source_path: string;
	source_mtime_ms: number;
	source_size_bytes: number;
	node_count: number;
	edge_count: number;
	rebuilt_at: string;
}

export interface ReplaceSessionContextInput {
	sessionId: string;
	nodes: SessionContextNode[];
	edges: SessionContextEdge[];
	artifacts: SessionContextArtifact[];
}

export interface SessionContextCheckpointInput {
	sessionId: string;
	sourcePath: string;
	sourceMtimeMs: number;
	sourceSizeBytes: number;
	nodeCount: number;
	edgeCount: number;
	rebuiltAt: string;
}

function parseMetadata(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}
function nodeFromRow(row: NodeRow): SessionContextNode {
	return {
		id: row.id,
		sessionId: row.session_id,
		kind: row.kind,
		title: redactSensitiveText(row.title),
		body: redactSensitiveText(row.body),
		compressedBody: redactSensitiveText(row.compressed_body),
		importance: row.importance,
		createdAt: row.created_at,
		...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
		...(typeof row.source_turn_index === "number" ? { sourceTurnIndex: row.source_turn_index } : {}),
		metadata: parseMetadata(row.metadata_json),
	};
}

function artifactFromRow(row: ArtifactRow): SessionContextArtifact {
	return {
		id: row.id,
		sessionId: row.session_id,
		...(row.node_id ? { nodeId: row.node_id } : {}),
		kind: row.kind,
		ref: redactSensitiveText(row.ref),
		label: redactSensitiveText(row.label),
		metadata: parseMetadata(row.metadata_json),
	};
}

function edgeFromRow(row: EdgeRow): SessionContextEdge {
	return {
		id: row.id,
		sessionId: row.session_id,
		sourceNodeId: row.source_node_id,
		targetNodeId: row.target_node_id,
		relation: row.relation,
		weight: row.weight,
		...(row.evidence_message_id ? { evidenceMessageId: row.evidence_message_id } : {}),
		metadata: parseMetadata(row.metadata_json),
	};
}

/** Get the highest sourceTurnIndex among existing nodes for a session. Used by incremental extraction to avoid ID collisions. */
export function getMaxSourceTurnIndex(sessionId: string): number {
	const row = getDb().query<{ m: number | null }, [string]>(
		`SELECT MAX(source_turn_index) AS m FROM session_context_nodes WHERE session_id = ?`,
	).get(sessionId);
	return row?.m ?? 0;
}

/** Return the current node count for a session. Used by incremental checkpoint. */
export function countSessionContextNodes(sessionId: string): number {
	const row = getDb().query<{ c: number }, [string]>(
		`SELECT COUNT(*) AS c FROM session_context_nodes WHERE session_id = ?`,
	).get(sessionId);
	return row?.c ?? 0;
}


export function replaceSessionContext(input: ReplaceSessionContextInput): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare("DELETE FROM session_context_artifacts WHERE session_id = ?").run(input.sessionId);
		db.prepare("DELETE FROM session_context_edges WHERE session_id = ?").run(input.sessionId);
		db.prepare("DELETE FROM session_context_nodes WHERE session_id = ?").run(input.sessionId);

		const insertNode = db.prepare(`
			INSERT OR REPLACE INTO session_context_nodes (
				id, session_id, kind, title, body, compressed_body,
				source_message_id, source_turn_index, importance, created_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const node of input.nodes) {
			insertNode.run(
				node.id,
				node.sessionId,
				node.kind,
				redactSensitiveText(node.title),
				redactSensitiveText(node.body),
				redactSensitiveText(node.compressedBody),
				node.sourceMessageId ?? null,
				node.sourceTurnIndex ?? null,
				node.importance,
				node.createdAt,
				JSON.stringify(node.metadata),
			);
		}

		const insertEdge = db.prepare(`
			INSERT OR REPLACE INTO session_context_edges (
				id, session_id, source_node_id, target_node_id, relation,
				weight, evidence_message_id, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const edge of input.edges) {
			insertEdge.run(
				edge.id,
				edge.sessionId,
				edge.sourceNodeId,
				edge.targetNodeId,
				edge.relation,
				edge.weight,
				edge.evidenceMessageId ?? null,
				JSON.stringify(edge.metadata),
			);
		}

		const insertArtifact = db.prepare(`
			INSERT OR REPLACE INTO session_context_artifacts (
				id, session_id, node_id, kind, ref, label, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		for (const artifact of input.artifacts) {
			insertArtifact.run(
				artifact.id,
				artifact.sessionId,
				artifact.nodeId ?? null,
				artifact.kind,
				redactSensitiveText(artifact.ref),
				redactSensitiveText(artifact.label),
				JSON.stringify(artifact.metadata),
			);
		}
	});
	tx();
}

export function insertSessionContextNodes(input: ReplaceSessionContextInput): void {
	const db = getDb();
	const tx = db.transaction(() => {
		const insertNode = db.prepare(`
			INSERT OR REPLACE INTO session_context_nodes (
				id, session_id, kind, title, body, compressed_body,
				source_message_id, source_turn_index, importance, created_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const node of input.nodes) {
			insertNode.run(
				node.id,
				node.sessionId,
				node.kind,
				redactSensitiveText(node.title),
				redactSensitiveText(node.body),
				redactSensitiveText(node.compressedBody),
				node.sourceMessageId ?? null,
				node.sourceTurnIndex ?? null,
				node.importance,
				node.createdAt,
				JSON.stringify(node.metadata),
			);
		}
		const insertEdge = db.prepare(`
			INSERT OR REPLACE INTO session_context_edges (
				id, session_id, source_node_id, target_node_id, relation,
				weight, evidence_message_id, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const edge of input.edges) {
			insertEdge.run(edge.id, edge.sessionId, edge.sourceNodeId, edge.targetNodeId, edge.relation, edge.weight, edge.evidenceMessageId ?? null, JSON.stringify(edge.metadata));
		}
		const insertArtifact = db.prepare(`
			INSERT OR REPLACE INTO session_context_artifacts (
				id, session_id, node_id, kind, ref, label, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		for (const artifact of input.artifacts) {
			insertArtifact.run(artifact.id, artifact.sessionId, artifact.nodeId ?? null, artifact.kind, redactSensitiveText(artifact.ref), redactSensitiveText(artifact.label), JSON.stringify(artifact.metadata));
		}
	});
	tx();
}

export function upsertSessionContextCheckpoint(input: SessionContextCheckpointInput): void {
	getDb().prepare(
		`INSERT INTO session_context_checkpoints (
			session_id, source_path, source_mtime_ms, source_size_bytes,
			node_count, edge_count, rebuilt_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				source_path = excluded.source_path,
				source_mtime_ms = excluded.source_mtime_ms,
				source_size_bytes = excluded.source_size_bytes,
				node_count = excluded.node_count,
				edge_count = excluded.edge_count,
				rebuilt_at = excluded.rebuilt_at`,
	).run(
		input.sessionId,
		input.sourcePath,
		input.sourceMtimeMs,
		input.sourceSizeBytes,
		input.nodeCount,
		input.edgeCount,
		input.rebuiltAt,
	);
}

export function getSessionContextStatus(sessionId: string): SessionContextStatusResponse {
	const row = getDb()
		.prepare(
			"SELECT session_id, source_path, source_mtime_ms, source_size_bytes, node_count, edge_count, rebuilt_at FROM session_context_checkpoints WHERE session_id = ?",
		)
		.get(sessionId) as CheckpointRow | undefined;
	if (!row) {
		return {
			sessionId,
			built: false,
			nodeCount: 0,
			edgeCount: 0,
		};
	}
	return {
		sessionId: row.session_id,
		built: true,
		nodeCount: row.node_count,
		edgeCount: row.edge_count,
		rebuiltAt: row.rebuilt_at,
		sourceMtimeMs: row.source_mtime_ms,
		sourceSizeBytes: row.source_size_bytes,
	};
}

export function getSessionContextGraph(sessionId: string, limit: number): SessionContextGraphResponse {
	const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 200;
	const rows = getDb().query<NodeRow, [string, number]>(
		`SELECT * FROM session_context_nodes WHERE session_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?`,
	).all(sessionId, boundedLimit);
	const nodes = rows.map(nodeFromRow);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edgeRows = getDb().query<EdgeRow, [string]>(
		`SELECT * FROM session_context_edges WHERE session_id = ? ORDER BY weight DESC`,
	).all(sessionId);
	const edges = edgeRows.filter((edge) => nodeIds.has(edge.source_node_id) && nodeIds.has(edge.target_node_id)).map(edgeFromRow);
	const artifactRows = getDb().query<ArtifactRow, [string]>(
		`SELECT * FROM session_context_artifacts WHERE session_id = ? ORDER BY kind, label`,
	).all(sessionId);
	const totalRow = getDb().query<{ c: number }, [string]>(
		`SELECT COUNT(*) AS c FROM session_context_nodes WHERE session_id = ?`,
	).get(sessionId);
	const totalNodes = totalRow?.c ?? nodes.length;
	return {
		sessionId,
		nodes,
		edges,
		artifacts: artifactRows.filter((artifact) => !artifact.node_id || nodeIds.has(artifact.node_id)).map(artifactFromRow),
		totalNodes,
		truncated: totalNodes > nodes.length,
	};
}


export function getNodeEmbeddings(sessionId: string): Map<string, number[]> {
	const rows = getDb().query<{ node_id: string; embedding: Uint8Array }, [string]>(
		`SELECT node_id, embedding FROM session_context_node_embeddings WHERE session_id = ?`,
	).all(sessionId);
	const result = new Map<string, number[]>();
	for (const row of rows) {
		const floats = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
		result.set(row.node_id, Array.from(floats));
	}
	return result;
}

export function saveNodeEmbeddings(input: { sessionId: string; model: string; entries: Array<{ nodeId: string; embedding: number[] }> }): void {
	const db = getDb();
	const tx = db.transaction(() => {
		const upsert = db.prepare(`
			INSERT INTO session_context_node_embeddings (session_id, node_id, embedding, model, created_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(session_id, node_id) DO UPDATE SET
				embedding = excluded.embedding,
				model = excluded.model,
				created_at = excluded.created_at
		`);
		const now = new Date().toISOString();
		for (const entry of input.entries) {
			const bytes = new Float32Array(entry.embedding);
			upsert.run(input.sessionId, entry.nodeId, Buffer.from(bytes.buffer), input.model, now);
		}
	});
	tx();
}