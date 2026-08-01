/**
 * Parse the `<session_topology_subgraph>` focus payload returned by
 * `GET /sessions/:id/context-focus` into typed UI data.
 *
 * The focus text is model-facing: instructions followed by the tagged JSON
 * block. The UI needs the structured nodes/edges to render "which nodes is
 * this conversation currently focusing on" without re-running retrieval.
 */

import type {
	SessionContextArtifactKind,
	SessionContextChildType,
	SessionContextEdgeRelation,
	SessionContextNodeKind,
	SessionContextNodeOrigin,
	SessionContextNodeStatus,
	SessionContextOperation,
	SessionContextPurposeSource,
	SessionTopologyFocusSource,
	SessionTopologyFocusV2Child,
	SessionTopologyFocusV2Node,
} from "@omp-deck/protocol";

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

export interface TopologyFocusV1 {
	schemaVersion: 1;
	query: string;
	nodes: FocusNode[];
	edges: FocusEdge[];
	artifactCount: number;
	omittedNodeCount: number;
}

export interface TopologyFocusV2Pair {
	pairId: string;
	user: SessionTopologyFocusV2Node;
	assistant?: SessionTopologyFocusV2Node;
	children: SessionTopologyFocusV2Child[];
	artifacts: Array<{ kind: SessionContextArtifactKind; ref: string; label?: string; nodeId?: string }>;
}

export interface TopologyFocusV2 {
	schemaVersion: 2;
	sessionId: string;
	query: string;
	pairs: TopologyFocusV2Pair[];
	omitted: { pairCount: number; childCount: number; artifactCount: number; reason: string };
}

export type TopologyFocus = TopologyFocusV1 | TopologyFocusV2;

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
	if (!isRecord(payload)) return null;
	if (payload.schemaVersion === 2) return parseV2(payload);
	if (payload.schemaVersion !== undefined && payload.schemaVersion !== 1) return null;
	return parseV1(payload);
}

function parseV1(p: Record<string, unknown>): TopologyFocusV1 {
	const nodes: FocusNode[] = [];
	if (Array.isArray(p.nodes)) {
		for (const n of p.nodes) {
			if (!isRecord(n) || typeof n.id !== "string" || typeof n.title !== "string") continue;
			const kind = typeof n.kind === "string" && NODE_KINDS.has(n.kind) ? n.kind as SessionContextNodeKind : "evidence";
			const source = sanitizeSource(n.source) ?? {};
			nodes.push({ id: n.id, kind, title: n.title, body: typeof n.body === "string" ? n.body : "", source });
		}
	}
	const edges: FocusEdge[] = [];
	if (Array.isArray(p.edges)) {
		for (const e of p.edges) {
			if (isRecord(e) && typeof e.sourceNodeId === "string" && typeof e.targetNodeId === "string" && typeof e.relation === "string") {
				edges.push({ sourceNodeId: e.sourceNodeId, relation: e.relation as SessionContextEdgeRelation, targetNodeId: e.targetNodeId });
			}
		}
	}
	const omittedNodeCount = isRecord(p.omitted) && typeof p.omitted.nodeCount === "number" ? p.omitted.nodeCount : 0;
	return { schemaVersion: 1, query: typeof p.query === "string" ? p.query : "", nodes, edges, artifactCount: Array.isArray(p.artifacts) ? p.artifacts.length : 0, omittedNodeCount };
}

function parseV2(p: Record<string, unknown>): TopologyFocusV2 | null {
	if (p.type !== "session_topology_subgraph" || typeof p.sessionId !== "string" || typeof p.query !== "string" || !Array.isArray(p.pairs) || !isRecord(p.omitted)) return null;
	const omitted = p.omitted;
	if (typeof omitted.pairCount !== "number" || typeof omitted.childCount !== "number" || typeof omitted.artifactCount !== "number" || typeof omitted.reason !== "string") return null;
	const pairs: TopologyFocusV2Pair[] = [];
	for (const value of p.pairs) {
		if (!isRecord(value) || typeof value.pairId !== "string" || !Array.isArray(value.children) || !Array.isArray(value.artifacts)) return null;
		const user = sanitizeV2Node(value.user);
		if (!user) return null;
		const assistant = value.assistant === undefined ? undefined : sanitizeV2Node(value.assistant);
		if (value.assistant !== undefined && !assistant) return null;
		const children: SessionTopologyFocusV2Child[] = [];
		for (const childValue of value.children) {
			const childRecord = isRecord(childValue) ? childValue : undefined;
			const child = sanitizeV2Node(childValue);
			if (!childRecord || !child || typeof childRecord.childType !== "string") return null;
			children.push({ ...child, childType: childRecord.childType as SessionContextChildType, ...(typeof childRecord.origin === "string" ? { origin: childRecord.origin as SessionContextNodeOrigin } : {}) });
		}
		const artifacts: TopologyFocusV2Pair["artifacts"] = [];
		for (const artifactValue of value.artifacts) {
			if (!isRecord(artifactValue) || typeof artifactValue.kind !== "string" || typeof artifactValue.ref !== "string") return null;
			artifacts.push({ kind: artifactValue.kind as SessionContextArtifactKind, ref: artifactValue.ref, ...(typeof artifactValue.label === "string" ? { label: artifactValue.label } : {}), ...(typeof artifactValue.nodeId === "string" ? { nodeId: artifactValue.nodeId } : {}) });
		}
		pairs.push({ pairId: value.pairId, user, ...(assistant ? { assistant } : {}), children, artifacts });
	}
	return { schemaVersion: 2, sessionId: p.sessionId, query: p.query, pairs, omitted: { pairCount: omitted.pairCount, childCount: omitted.childCount, artifactCount: omitted.artifactCount, reason: omitted.reason } };
}

function sanitizeV2Node(value: unknown): SessionTopologyFocusV2Node | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.body !== "string" || value.body.trim().length === 0) return null;
	const source = sanitizeSource(value.source);
	return {
		id: value.id,
		...(typeof value.operation === "string" ? { operation: value.operation as SessionContextOperation } : {}),
		...(typeof value.operationDetail === "string" ? { operationDetail: value.operationDetail } : {}),
		...(value.purpose === null || typeof value.purpose === "string" ? { purpose: value.purpose as string | null } : {}),
		...(typeof value.purposeSource === "string" ? { purposeSource: value.purposeSource as SessionContextPurposeSource } : {}),
		...(typeof value.refinedPurpose === "string" ? { refinedPurpose: value.refinedPurpose } : {}),
		body: value.body,
		...(typeof value.status === "string" ? { status: value.status as SessionContextNodeStatus } : {}),
		...(source ? { source } : {}),
	};
}

function sanitizeSource(value: unknown): SessionTopologyFocusSource | undefined {
	if (!isRecord(value)) return undefined;
	const source = { ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}), ...(typeof value.turnIndex === "number" ? { turnIndex: value.turnIndex } : {}) };
	return source.messageId || source.turnIndex !== undefined ? source : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function topologyFocusNodeIds(focus: TopologyFocus | null): string[] {
	if (!focus) return [];
	if (focus.schemaVersion === 1) return focus.nodes.map((node) => node.id);
	return focus.pairs.flatMap((pair) => [pair.user.id, ...(pair.assistant ? [pair.assistant.id] : []), ...pair.children.map((child) => child.id)]);
}

export function topologyFocusV1Projection(focus: TopologyFocus): TopologyFocusV1 {
	if (focus.schemaVersion === 1) return focus;
	const nodes: FocusNode[] = focus.pairs.flatMap((pair) => [
		{ id: pair.user.id, kind: "user_intent", title: pair.user.purpose ?? pair.user.refinedPurpose ?? pair.user.operationDetail ?? pair.user.operation ?? "User intent", body: pair.user.body, source: pair.user.source ?? {} },
		...(pair.assistant ? [{ id: pair.assistant.id, kind: "resolution" as const, title: pair.assistant.purpose ?? pair.assistant.refinedPurpose ?? pair.assistant.operationDetail ?? pair.assistant.operation ?? "Assistant answer", body: pair.assistant.body, source: pair.assistant.source ?? {} }] : []),
		...pair.children.map((child) => ({ id: child.id, kind: "evidence" as const, title: child.purpose ?? child.refinedPurpose ?? child.operationDetail ?? child.childType, body: child.body, source: child.source ?? {} })),
	]);
	return {
		schemaVersion: 1,
		query: focus.query,
		nodes,
		edges: [],
		artifactCount: focus.pairs.reduce((count, pair) => count + pair.artifacts.length, 0),
		omittedNodeCount: focus.omitted.pairCount + focus.omitted.childCount,
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
