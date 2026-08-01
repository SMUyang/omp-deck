import type { SessionContextGraphResponse, SessionContextNode } from "@omp-deck/protocol";

import type { PairRetrievalResult } from "./session-pair-retrieval.ts";
import type { RetrievedTopology } from "./session-topology-retrieval.ts";
import { redactSensitiveText } from "./redaction.ts";

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
	rerankTopology(input: { modelRole: string; request: TopologyRerankRequest | TopologyPairRerankRequest; timeoutMs: number }): Promise<unknown>;
}

export interface TopologyRerankPairCandidate {
	pairId: string;
	user?: { id: string; operation?: string; purpose?: string | null; title: string; body: string };
	assistant?: { id: string; operation?: string; purpose?: string | null; title: string; body: string };
	children: Array<{ id: string; childType?: string; operation?: string; purpose?: string | null; body: string }>;
}

export interface TopologyPairRerankRequest {
	task: "query_pair_rerank";
	query: string;
	candidatePairs: TopologyRerankPairCandidate[];
	budget: { pairLimit: number; nodeLimit: number; childLimit: number };
}

export interface PairRerankPatch {
	keepPairIds: string[];
	keepChildIds: string[];
	demotePairIds: string[];
	reason?: string;
}

function boundedExternalText(value: string | null | undefined, limit: number): string | undefined {
	const normalized = redactSensitiveText(value ?? "").replace(/\s+/g, " ").trim();
	return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}

function externalMain(node: SessionContextNode | undefined): TopologyRerankPairCandidate["user"] | undefined {
	if (!node) return undefined;
	const operation = boundedExternalText(node.operation, 64);
	const purpose = boundedExternalText(node.refinedPurpose ?? node.purpose, 256);
	return { id: node.id, ...(operation ? { operation } : {}), ...(node.purpose === null ? { purpose: null } : purpose ? { purpose } : {}), title: boundedExternalText(node.title, 256) ?? "", body: boundedExternalText(node.compressedBody || node.body, 512) ?? "" };
}

export function buildTopologyPairRerankRequest(input: { query: string; graph: SessionContextGraphResponse; local: PairRetrievalResult; pairLimit: number; nodeLimit: number; childLimit: number }): TopologyPairRerankRequest {
	const candidatePairs = input.local.ranking.map(({ unitId: pairId }): TopologyRerankPairCandidate => {
		const pairNodes = input.graph.nodes.filter((node) => node.pairId === pairId);
		const user = externalMain(pairNodes.find((node) => node.nodeRole === "main" && node.population === "user"));
		const assistantNode = pairNodes.find((node) => node.nodeRole === "main" && node.population === "assistant");
		const assistant = externalMain(assistantNode);
		const children = pairNodes.filter((node) => node.nodeRole === "child" && (!assistantNode || node.parentNodeId === assistantNode.id)).map((node) => {
			const childType = boundedExternalText(node.childType, 64);
			const operation = boundedExternalText(node.operation, 64);
			const purpose = boundedExternalText(node.refinedPurpose ?? node.purpose, 256);
			return { id: node.id, ...(childType ? { childType } : {}), ...(operation ? { operation } : {}), ...(node.purpose === null ? { purpose: null } : purpose ? { purpose } : {}), body: boundedExternalText(node.compressedBody || node.body, 512) ?? "" };
		});
		return { pairId, ...(user ? { user } : {}), ...(assistant ? { assistant } : {}), children };
	});
	return { task: "query_pair_rerank", query: boundedExternalText(input.query, 512) ?? "", candidatePairs, budget: { pairLimit: input.pairLimit, nodeLimit: input.nodeLimit, childLimit: input.childLimit } };
}

export function parsePairRerankPatch(raw: unknown): PairRerankPatch | undefined {
	if (!isRecord(raw)) return undefined;
	const allowed = new Set(["keepPairIds", "keepChildIds", "demotePairIds", "reason"]);
	if (Object.keys(raw).some((key) => !allowed.has(key))) return undefined;
	const keepPairIds = stringArray(raw.keepPairIds ?? []);
	const keepChildIds = stringArray(raw.keepChildIds ?? []);
	const demotePairIds = stringArray(raw.demotePairIds ?? []);
	if (!keepPairIds || !keepChildIds || !demotePairIds || (raw.reason !== undefined && typeof raw.reason !== "string")) return undefined;
	const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 500) : undefined;
	return reason === undefined ? { keepPairIds, keepChildIds, demotePairIds } : { keepPairIds, keepChildIds, demotePairIds, reason };
}

export function validatePairRerankPatch(input: { patch: PairRerankPatch; graph: SessionContextGraphResponse; local: PairRetrievalResult; pairLimit: number; nodeLimit: number; childLimit: number }): PairRerankPatch | undefined {
	if (input.patch.keepPairIds.length > input.pairLimit || input.patch.keepChildIds.length > input.childLimit) return undefined;
	const pairIds = new Set(input.local.ranking.map((item) => item.unitId));
	const childOwner = new Map(input.graph.nodes.filter((node) => node.nodeRole === "child" && node.pairId).map((node) => [node.id, node.pairId!]));
	for (const id of [...input.patch.keepPairIds, ...input.patch.demotePairIds]) if (!pairIds.has(id)) return undefined;
	for (const id of input.patch.keepChildIds) { const pairId = childOwner.get(id); if (!pairId || !pairIds.has(pairId) || input.patch.demotePairIds.includes(pairId)) return undefined; }
	const keep = new Set(input.patch.keepPairIds);
	const demotePairIds = input.patch.demotePairIds.filter((id) => !keep.has(id));
	return input.patch.reason === undefined ? { keepPairIds: input.patch.keepPairIds, keepChildIds: input.patch.keepChildIds, demotePairIds } : { keepPairIds: input.patch.keepPairIds, keepChildIds: input.patch.keepChildIds, demotePairIds, reason: input.patch.reason };
}

export function applyPairRerankPatch(input: { local: PairRetrievalResult; graph: SessionContextGraphResponse; patch: PairRerankPatch; pairLimit: number; nodeLimit: number; childLimit: number; edgeLimit: number; artifactLimit: number }): PairRetrievalResult {
	const nodesByPair = new Map<string, SessionContextNode[]>();
	for (const node of input.graph.nodes) { if (!node.pairId) continue; const current = nodesByPair.get(node.pairId); if (current) current.push(node); else nodesByPair.set(node.pairId, [node]); }
	const childById = new Map(input.graph.nodes.filter((node) => node.nodeRole === "child").map((node) => [node.id, node]));
	const forcedChildrenByPair = new Map<string, string[]>();
	for (const childId of input.patch.keepChildIds) { const pairId = childById.get(childId)?.pairId; if (!pairId) continue; const current = forcedChildrenByPair.get(pairId); if (current) current.push(childId); else forcedChildrenByPair.set(pairId, [childId]); }
	const forcedPairIds = [...input.patch.keepPairIds];
	for (const pairId of forcedChildrenByPair.keys()) if (!forcedPairIds.includes(pairId)) forcedPairIds.push(pairId);
	const demoted = new Set(input.patch.demotePairIds);
	const order = [...forcedPairIds];
	for (const pairId of input.local.selectedPairIds) if (!order.includes(pairId) && !demoted.has(pairId)) order.push(pairId);
	const selectedPairIds: string[] = [];
	const selectedMainIds: string[] = [];
	const selectedChildIds: string[] = [];
	for (const pairId of order) {
		if (selectedPairIds.length >= input.pairLimit) break;
		const pairNodes = nodesByPair.get(pairId) ?? [];
		const mains = [pairNodes.find((node) => node.nodeRole === "main" && node.population === "user")?.id, pairNodes.find((node) => node.nodeRole === "main" && node.population === "assistant")?.id].filter((id): id is string => Boolean(id));
		const forcedChildren = forcedChildrenByPair.get(pairId) ?? [];
		if (mains.length === 0 || selectedChildIds.length + forcedChildren.length > input.childLimit || selectedMainIds.length + selectedChildIds.length + mains.length + forcedChildren.length > input.nodeLimit) continue;
		selectedPairIds.push(pairId); selectedMainIds.push(...mains); selectedChildIds.push(...forcedChildren);
	}
	for (const childId of input.local.selectedChildIds) { if (selectedChildIds.includes(childId) || selectedChildIds.length >= input.childLimit || selectedMainIds.length + selectedChildIds.length >= input.nodeLimit) continue; const child = childById.get(childId); if (child?.pairId && selectedPairIds.includes(child.pairId)) selectedChildIds.push(childId); }
	const selectedNodeIds = [...selectedMainIds, ...selectedChildIds];
	const selectedSet = new Set(selectedNodeIds);
	const selectedEdgeIds = input.graph.edges.filter((edge) => selectedSet.has(edge.sourceNodeId) && selectedSet.has(edge.targetNodeId)).slice(0, input.edgeLimit).map((edge) => edge.id);
	const artifacts = input.graph.artifacts.filter((artifact) => !artifact.nodeId || selectedSet.has(artifact.nodeId)).slice(0, input.artifactLimit).map((artifact) => ({ kind: artifact.kind, ref: artifact.ref, ...(artifact.nodeId ? { nodeId: artifact.nodeId } : {}), label: artifact.label }));
	return { ...input.local, selectedPairIds, selectedNodeIds, selectedChildIds, selectedEdgeIds, artifacts };
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
