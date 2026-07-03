import type {
	SessionContextGraphResponse,
	SessionContextNode,
} from "@omp-deck/protocol";

export interface RetrieveTopologyInput {
	sessionId: string;
	query: string;
	candidateNodeLimit: number;
	expansionHops: 1 | 2;
	outputNodeLimit: number;
	outputEdgeLimit: number;
	outputArtifactLimit: number;
}

export interface RetrievedArtifact {
	kind: string;
	ref: string;
	nodeId: string | undefined;
	label: string;
}

export interface RetrievedTopology {
	selectedNodeIds: string[];
	selectedEdgeIds: string[];
	artifacts: RetrievedArtifact[];
	omitted: { nodeCount: number; edgeCount: number; reason: string };
}

const KIND_WEIGHTS: Record<SessionContextNode["kind"], number> = {
	resolution: 0.95,
	decision: 0.92,
	goal: 0.9,
	user_intent: 0.88,
	constraint: 0.85,
	handoff_summary: 0.85,
	artifact: 0.6,
	todo_state: 0.65,
	evidence: 0.8,
	issue: 0.6,
	action: 0.7,
};

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_\u4e00-\u9fff]+/g)
		.filter((token) => token.length >= 2);
}

function nodeText(node: SessionContextNode): string {
	return `${node.title} ${node.compressedBody} ${node.body}`;
}

function textMatchScore(queryTokens: string[], node: SessionContextNode): number {
	if (queryTokens.length === 0) return 0;
	const nodeTokens = new Set(tokenize(nodeText(node)));
	if (nodeTokens.size === 0) return 0;
	let hits = 0;
	for (const token of queryTokens) {
		if (nodeTokens.has(token)) hits += 1;
	}
	return hits / queryTokens.length;
}

function clamp01(value: number | null | undefined): number {
	if (value === null || value === undefined) return 0;
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function scoreNode(node: SessionContextNode, queryTokens: string[]): number {
	const queryScore = textMatchScore(queryTokens, node);
	const importance = clamp01(node.importance);
	const kind = KIND_WEIGHTS[node.kind] ?? 0.5;
	return 0.45 * queryScore + 0.30 * importance + 0.25 * kind;
}

function expandNeighbors(
	seeds: Set<string>,
	graph: SessionContextGraphResponse,
	hops: 1 | 2,
): Set<string> {
	const result = new Set(seeds);
	let frontier = new Set(seeds);
	for (let i = 0; i < hops; i += 1) {
		const next = new Set<string>();
		for (const nodeId of frontier) {
			for (const edge of graph.edges) {
				if (edge.sourceNodeId === nodeId && !result.has(edge.targetNodeId)) next.add(edge.targetNodeId);
				if (edge.targetNodeId === nodeId && !result.has(edge.sourceNodeId)) next.add(edge.sourceNodeId);
			}
		}
		for (const id of next) result.add(id);
		frontier = next;
	}
	return result;
}

export function retrieveTopology(
	input: RetrieveTopologyInput,
	graph: SessionContextGraphResponse,
): RetrievedTopology | undefined {
	if (graph.nodes.length === 0) return undefined;

	const queryTokens = tokenize(input.query);
	const sorted = [...graph.nodes].sort((a, b) => scoreNode(b, queryTokens) - scoreNode(a, queryTokens));
	const candidates = sorted.slice(0, input.candidateNodeLimit);
	const candidateIds = new Set(candidates.map((node) => node.id));
	const expanded = expandNeighbors(candidateIds, graph, input.expansionHops);
	const orderedExpanded = graph.nodes.filter((node) => expanded.has(node.id));
	const selectedNodes = orderedExpanded.slice(0, input.outputNodeLimit);
	const selectedNodeIds = selectedNodes.map((node) => node.id);
	const selectedSet = new Set(selectedNodeIds);

	const edges = graph.edges
		.filter((edge) => selectedSet.has(edge.sourceNodeId) && selectedSet.has(edge.targetNodeId))
		.slice(0, input.outputEdgeLimit);
	const selectedEdgeIds = edges.map((edge) => edge.id);

	const artifacts = graph.artifacts
		.filter((artifact) => !artifact.nodeId || selectedSet.has(artifact.nodeId))
		.slice(0, input.outputArtifactLimit)
		.map((artifact) => ({
			kind: artifact.kind,
			ref: artifact.ref,
			nodeId: artifact.nodeId,
			label: artifact.label,
		}));

	return {
		selectedNodeIds,
		selectedEdgeIds,
		artifacts,
		omitted: {
			nodeCount: Math.max(0, (graph.totalNodes || graph.nodes.length) - selectedNodeIds.length),
			edgeCount: Math.max(0, graph.edges.length - selectedEdgeIds.length),
			reason: graph.truncated || graph.nodes.length > input.outputNodeLimit ? "budget" : "none",
		},
	};
}
