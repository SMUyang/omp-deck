/**
 * Parse the `<session_topology_subgraph>` focus payload returned by
 * `GET /sessions/:id/context-focus` into typed UI data.
 *
 * The focus text is model-facing: instructions followed by the tagged JSON
 * block. The UI needs the structured nodes/edges to render "which nodes is
 * this conversation currently focusing on" without re-running retrieval.
 */

import type { SessionContextEdgeRelation, SessionContextNodeKind } from "@omp-deck/protocol";

export interface FocusNode {
	id: string;
	kind: SessionContextNodeKind;
	title: string;
	/** Query-aware body; may carry `[query match]` markers from the server. */
	body: string;
	source: { messageId?: string; turnIndex?: number };
}

export interface FocusEdge {
	sourceNodeId: string;
	relation: SessionContextEdgeRelation;
	targetNodeId: string;
}

export interface TopologyFocus {
	query: string;
	nodes: FocusNode[];
	edges: FocusEdge[];
	artifactCount: number;
	omittedNodeCount: number;
}

const OPEN_TAG = "<session_topology_subgraph>";
const CLOSE_TAG = "</session_topology_subgraph>";

const NODE_KINDS: ReadonlySet<string> = new Set([
	"goal",
	"user_intent",
	"constraint",
	"decision",
	"action",
	"artifact",
	"issue",
	"resolution",
	"evidence",
	"todo_state",
	"handoff_summary",
]);

/**
 * Extract the tagged JSON payload. Returns null when the focus text is
 * empty, the tags are missing, or the JSON/shape is malformed — callers
 * treat null as "no focus available", never as an error worth surfacing.
 */
export function parseTopologyFocus(focusText: string): TopologyFocus | null {
	if (!focusText) return null;
	const start = focusText.indexOf(OPEN_TAG);
	const end = focusText.indexOf(CLOSE_TAG);
	if (start < 0 || end < 0 || end <= start) return null;
	const raw = focusText.slice(start + OPEN_TAG.length, end).trim();
	if (!raw) return null;

	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;

	const nodes: FocusNode[] = [];
	if (Array.isArray(p.nodes)) {
		for (const n of p.nodes) {
			if (!n || typeof n !== "object") continue;
			const r = n as Record<string, unknown>;
			if (typeof r.id !== "string" || typeof r.title !== "string") continue;
			const kind = typeof r.kind === "string" && NODE_KINDS.has(r.kind) ? (r.kind as SessionContextNodeKind) : "evidence";
			const src = r.source && typeof r.source === "object" ? (r.source as Record<string, unknown>) : {};
			nodes.push({
				id: r.id,
				kind,
				title: r.title,
				body: typeof r.body === "string" ? r.body : "",
				source: {
					messageId: typeof src.messageId === "string" ? src.messageId : undefined,
					turnIndex: typeof src.turnIndex === "number" ? src.turnIndex : undefined,
				},
			});
		}
	}

	const edges: FocusEdge[] = [];
	if (Array.isArray(p.edges)) {
		for (const e of p.edges) {
			if (!e || typeof e !== "object") continue;
			const r = e as Record<string, unknown>;
			if (
				typeof r.sourceNodeId === "string" &&
				typeof r.targetNodeId === "string" &&
				typeof r.relation === "string"
			) {
				edges.push({
					sourceNodeId: r.sourceNodeId,
					relation: r.relation as SessionContextEdgeRelation,
					targetNodeId: r.targetNodeId,
				});
			}
		}
	}

	const omittedNodeCount =
		p.omitted && typeof p.omitted === "object" && typeof (p.omitted as Record<string, unknown>).nodeCount === "number"
			? ((p.omitted as Record<string, unknown>).nodeCount as number)
			: 0;

	return {
		query: typeof p.query === "string" ? p.query : "",
		nodes,
		edges,
		artifactCount: Array.isArray(p.artifacts) ? p.artifacts.length : 0,
		omittedNodeCount,
	};
}

/** The most recent real user turn text — the query the current focus ranks against. */
export function latestUserText(messages: ReadonlyArray<{ role: string; text?: string }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user" && typeof m.text === "string" && m.text.trim().length > 0) {
			return m.text.trim();
		}
	}
	return "";
}

/** Split a node body into the plain part and the `[query match]` evidence part. */
export function splitQueryMatch(body: string): { text: string; matches: string[] } {
	const idx = body.indexOf("[query match]");
	if (idx < 0) return { text: body, matches: [] };
	const head = body.slice(0, idx).trim();
	const tail = body.slice(idx);
	const matches = tail.split("[query match]").map((s) => s.trim()).filter((s) => s.length > 0);
	return { text: head, matches };
}
