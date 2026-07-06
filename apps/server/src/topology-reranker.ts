import type { SessionContextGraphResponse } from "@omp-deck/protocol";

import type { RetrievedTopology } from "./session-topology-retrieval.ts";

export interface TopologyRerankRequest {
	task: "query_rerank";
	query: string;
	candidateNodes: Array<{ id: string; kind: string; title: string; body: string }>;
	candidateEdges: Array<{ id: string; sourceNodeId: string; relation: string; targetNodeId: string }>;
	budget: { nodeLimit: number; edgeLimit: number };
}

export interface RerankPatch {
	keepNodeIds: string[];
	keepEdgeIds: string[];
	demoteNodeIds: string[];
	reason?: string;
}

export interface TopologyRerankModelClient {
	rerankTopology(input: { modelRole: string; request: TopologyRerankRequest; timeoutMs: number }): Promise<unknown>;
}

export function shouldExternalRerank(input: {
	enabled: boolean;
	contextPercent?: number | null;
	candidateNodeCount: number;
	localTopScore: number;
	minContextPercent: number;
	minCandidateNodes: number;
	localConfidenceBelow: number;
}): boolean {
	if (!input.enabled) return false;
	if ((input.contextPercent ?? 0) < input.minContextPercent) return false;
	return input.candidateNodeCount >= input.minCandidateNodes || input.localTopScore < input.localConfidenceBelow;
}

export function buildTopologyRerankRequest(input: {
	query: string;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	nodeLimit: number;
	edgeLimit: number;
}): TopologyRerankRequest {
	const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
	const edgeSet = new Set(input.local.selectedEdgeIds);
	return {
		task: "query_rerank",
		query: input.query,
		candidateNodes: input.local.selectedNodeIds
			.map((id) => nodeById.get(id))
			.filter((node): node is NonNullable<typeof node> => Boolean(node))
			.map((node) => ({ id: node.id, kind: node.kind, title: node.title, body: node.compressedBody || node.body })),
		candidateEdges: input.graph.edges
			.filter((edge) => edgeSet.has(edge.id))
			.map((edge) => ({ id: edge.id, sourceNodeId: edge.sourceNodeId, relation: edge.relation, targetNodeId: edge.targetNodeId })),
		budget: { nodeLimit: input.nodeLimit, edgeLimit: input.edgeLimit },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		if (!result.includes(item)) result.push(item);
	}
	return result;
}

export function parseRerankPatch(raw: unknown): RerankPatch | undefined {
	if (!isRecord(raw)) return undefined;
	const allowed = new Set(["keepNodeIds", "keepEdgeIds", "demoteNodeIds", "reason"]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) return undefined;
	}
	const keepNodeIds = stringArray(raw.keepNodeIds ?? []);
	const keepEdgeIds = stringArray(raw.keepEdgeIds ?? []);
	const demoteNodeIds = stringArray(raw.demoteNodeIds ?? []);
	if (!keepNodeIds || !keepEdgeIds || !demoteNodeIds) return undefined;
	if (raw.reason !== undefined && typeof raw.reason !== "string") return undefined;
	const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 500) : undefined;
	return reason === undefined ? { keepNodeIds, keepEdgeIds, demoteNodeIds } : { keepNodeIds, keepEdgeIds, demoteNodeIds, reason };
}

export function validateRerankPatch(input: {
	patch: RerankPatch;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	outputNodeLimit: number;
	outputEdgeLimit: number;
}): RerankPatch | undefined {
	if (input.patch.keepNodeIds.length > input.outputNodeLimit) return undefined;
	if (input.patch.keepEdgeIds.length > input.outputEdgeLimit) return undefined;
	const selectedNodes = new Set(input.local.selectedNodeIds);
	const selectedEdges = new Set(input.local.selectedEdgeIds);
	for (const id of [...input.patch.keepNodeIds, ...input.patch.demoteNodeIds]) {
		if (!selectedNodes.has(id)) return undefined;
	}
	for (const id of input.patch.keepEdgeIds) {
		if (!selectedEdges.has(id)) return undefined;
		const edge = input.graph.edges.find((candidate) => candidate.id === id);
		if (!edge || !selectedNodes.has(edge.sourceNodeId) || !selectedNodes.has(edge.targetNodeId)) return undefined;
	}
	const keep = new Set(input.patch.keepNodeIds);
	const demoteNodeIds = input.patch.demoteNodeIds.filter((id) => !keep.has(id));
	return input.patch.reason === undefined
		? { keepNodeIds: input.patch.keepNodeIds, keepEdgeIds: input.patch.keepEdgeIds, demoteNodeIds }
		: { keepNodeIds: input.patch.keepNodeIds, keepEdgeIds: input.patch.keepEdgeIds, demoteNodeIds, reason: input.patch.reason };
}

export function applyRerankPatch(input: {
	local: RetrievedTopology;
	graph: SessionContextGraphResponse;
	patch: RerankPatch;
	outputNodeLimit: number;
	outputEdgeLimit: number;
}): RetrievedTopology {
	const demote = new Set(input.patch.demoteNodeIds);
	const selected: string[] = [];
	for (const id of input.patch.keepNodeIds) {
		if (!selected.includes(id)) selected.push(id);
	}
	for (const id of input.local.selectedNodeIds) {
		if (selected.length >= input.outputNodeLimit) break;
		if (demote.has(id) || selected.includes(id)) continue;
		selected.push(id);
	}
	if (selected.length === 0) return input.local;
	const selectedSet = new Set(selected);
	const edgeById = new Map(input.graph.edges.map((edge) => [edge.id, edge]));
	const edges: string[] = [];
	for (const id of input.patch.keepEdgeIds) {
		const edge = edgeById.get(id);
		if (!edge || !selectedSet.has(edge.sourceNodeId) || !selectedSet.has(edge.targetNodeId)) continue;
		if (!edges.includes(id)) edges.push(id);
	}
	for (const id of input.local.selectedEdgeIds) {
		if (edges.length >= input.outputEdgeLimit) break;
		const edge = edgeById.get(id);
		if (!edge || !selectedSet.has(edge.sourceNodeId) || !selectedSet.has(edge.targetNodeId)) continue;
		if (!edges.includes(id)) edges.push(id);
	}
	return {
		...input.local,
		selectedNodeIds: selected,
		selectedEdgeIds: edges.slice(0, input.outputEdgeLimit),
		artifacts: input.local.artifacts.filter((artifact) => !artifact.nodeId || selectedSet.has(artifact.nodeId)),
	};
}

function withTimeout<T>(input: Promise<T>, timeoutMs: number): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`topology rerank timeout after ${timeoutMs}ms`)), timeoutMs);
	input.then(
		(value) => {
			clearTimeout(timer);
			resolve(value);
		},
		(error: unknown) => {
			clearTimeout(timer);
			reject(error);
		},
	);
	return promise;
}

export async function rerankTopologyWithExternalApi(input: {
	client: TopologyRerankModelClient;
	modelRole: string;
	timeoutMs: number;
	query: string;
	graph: SessionContextGraphResponse;
	local: RetrievedTopology;
	outputNodeLimit: number;
	outputEdgeLimit: number;
}): Promise<RetrievedTopology | undefined> {
	try {
		const request = buildTopologyRerankRequest({ query: input.query, graph: input.graph, local: input.local, nodeLimit: input.outputNodeLimit, edgeLimit: input.outputEdgeLimit });
		const raw = await withTimeout(input.client.rerankTopology({ modelRole: input.modelRole, request, timeoutMs: input.timeoutMs }), input.timeoutMs);
		const parsed = parseRerankPatch(raw);
		if (!parsed) return undefined;
		const valid = validateRerankPatch({ patch: parsed, graph: input.graph, local: input.local, outputNodeLimit: input.outputNodeLimit, outputEdgeLimit: input.outputEdgeLimit });
		if (!valid) return undefined;
		return applyRerankPatch({ local: input.local, graph: input.graph, patch: valid, outputNodeLimit: input.outputNodeLimit, outputEdgeLimit: input.outputEdgeLimit });
	} catch {
		return undefined;
	}
}
