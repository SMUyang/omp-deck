import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

import { getDb } from "./index.ts";

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
		title: row.title,
		body: row.body,
		compressedBody: row.compressed_body,
		importance: row.importance,
		createdAt: row.created_at,
		...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
		...(typeof row.source_turn_index === "number" ? { sourceTurnIndex: row.source_turn_index } : {}),
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

function artifactFromRow(row: ArtifactRow): SessionContextArtifact {
	return {
		id: row.id,
		sessionId: row.session_id,
		...(row.node_id ? { nodeId: row.node_id } : {}),
		kind: row.kind,
		ref: row.ref,
		label: row.label,
		metadata: parseMetadata(row.metadata_json),
	};
}

export function replaceSessionContext(input: ReplaceSessionContextInput): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.run("DELETE FROM session_context_artifacts WHERE session_id = ?", input.sessionId);
		db.run("DELETE FROM session_context_edges WHERE session_id = ?", input.sessionId);
		db.run("DELETE FROM session_context_nodes WHERE session_id = ?", input.sessionId);

		const insertNode = db.prepare(`
			INSERT INTO session_context_nodes (
				id, session_id, kind, title, body, compressed_body,
				source_message_id, source_turn_index, importance, created_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const node of input.nodes) {
			insertNode.run(
				node.id,
				node.sessionId,
				node.kind,
				node.title,
				node.body,
				node.compressedBody,
				node.sourceMessageId ?? null,
				node.sourceTurnIndex ?? null,
				node.importance,
				node.createdAt,
				JSON.stringify(node.metadata),
			);
		}

		const insertEdge = db.prepare(`
			INSERT INTO session_context_edges (
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
			INSERT INTO session_context_artifacts (
				id, session_id, node_id, kind, ref, label, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		for (const artifact of input.artifacts) {
			insertArtifact.run(
				artifact.id,
				artifact.sessionId,
				artifact.nodeId ?? null,
				artifact.kind,
				artifact.ref,
				artifact.label,
				JSON.stringify(artifact.metadata),
			);
		}
	});
	tx();
}

export function upsertSessionContextCheckpoint(input: SessionContextCheckpointInput): void {
	getDb().run(
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
		input.sessionId,
		input.sourcePath,
		input.sourceMtimeMs,
		input.sourceSizeBytes,
		input.nodeCount,
		input.edgeCount,
		input.rebuiltAt,
	);
}

export function getSessionContextGraph(sessionId: string, limit: number): SessionContextGraphResponse {
	const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 200, 1), 500);
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
		artifacts: artifactRows.map(artifactFromRow),
		totalNodes,
		truncated: totalNodes > nodes.length,
	};
}
