/**
 * Legacy schema-v1 compatibility retrieval.
 *
 * Conversational schema-v2 focus selection must use session-pair-retrieval.ts
 * over the complete graph instead of this bounded, node-first implementation.
 */
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

export interface RetrievedNodeRanking {
	nodeId: string;
	score: number;
	reasons: {
		query: number;
		importance: number;
		kind: number;
	};
}

export interface RetrievedTopology {
	selectedNodeIds: string[];
	selectedEdgeIds: string[];
	candidateNodeIds: string[];
	candidateEdgeIds: string[];
	rankedCandidateNodeIds: string[];
	candidateNodeCount: number;
	ranking: RetrievedNodeRanking[];
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

const CHINESE_STOPWORDS = new Set([
	"的", "了", "吗", "呢", "吧", "啊", "哦", "嗯", "哼",
	"是", "在", "有", "和", "与", "或", "但", "而", "这", "那", "个",
	"我", "你", "他", "她", "它", "我们", "你们", "他们",
	"就", "都", "也", "很", "非常", "最", "更", "太", "已经", "正在",
	"上", "下", "中", "里", "外", "前", "后", "左", "右", "间",
	"对", "错", "好", "坏", "大", "小", "多", "少", "全", "图",
]);

const TOKEN_LIMIT = 64;
const TOKEN_RUN_PATTERN = /[a-z0-9_]+|[\u4e00-\u9fff]+/g;

export function tokenize(text: string): string[] {
	const normalized = text.toLowerCase();
	const tokens: string[] = [];
	const seen = new Set<string>();
	const hanRuns: string[] = [];
	const addToken = (token: string): void => {
		if (tokens.length >= TOKEN_LIMIT || token.length < 2 || CHINESE_STOPWORDS.has(token) || seen.has(token)) return;
		seen.add(token);
		tokens.push(token);
	};

	for (const match of normalized.matchAll(TOKEN_RUN_PATTERN)) {
		const run = match[0];
		addToken(run);
		const firstCodePoint = run.charCodeAt(0);
		if (firstCodePoint >= 0x4e00 && firstCodePoint <= 0x9fff && hanRuns.length < TOKEN_LIMIT) hanRuns.push(run);
		if (tokens.length >= TOKEN_LIMIT) return tokens;
	}

	// Generate lazily and round-robin by offset so no Han run allocates an unbounded n-gram list or starves later runs.
	for (const size of [2, 3]) {
		for (let offset = 0; tokens.length < TOKEN_LIMIT; offset += 1) {
			let generated = false;
			for (const run of hanRuns) {
				if (offset + size > run.length) continue;
				generated = true;
				addToken(run.slice(offset, offset + size));
				if (tokens.length >= TOKEN_LIMIT) break;
			}
			if (!generated) break;
		}
	}
	return tokens;
}

function nodeText(node: SessionContextNode): string {
	return `${node.title} ${node.compressedBody} ${node.body}`;
}

function queryTokenIdf(uniqueQueryTokens: string[], nodes: SessionContextNode[]): Map<string, number> {
	const documentFrequency = new Map(uniqueQueryTokens.map((token) => [token, 0]));
	for (const node of nodes) {
		const nodeTokens = new Set(tokenize(nodeText(node)));
		for (const token of uniqueQueryTokens) {
			if (nodeTokens.has(token)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}
	const idfByToken = new Map<string, number>();
	for (const token of uniqueQueryTokens) {
		const df = documentFrequency.get(token) ?? 0;
		idfByToken.set(token, Math.log((nodes.length + 1) / (df + 1)) + 1);
	}
	return idfByToken;
}

function textMatchScore(queryTokens: string[], idfByToken: Map<string, number>, node: SessionContextNode): number {
	if (queryTokens.length === 0) return 0;
	const nodeTokens = new Set(tokenize(nodeText(node)));
	if (nodeTokens.size === 0) return 0;
	let matchedWeight = 0;
	let totalWeight = 0;
	for (const token of queryTokens) {
		const weight = idfByToken.get(token) ?? 1;
		totalWeight += weight;
		if (nodeTokens.has(token)) matchedWeight += weight;
	}
	return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

function clamp01(value: number | null | undefined): number {
	if (value === null || value === undefined) return 0;
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function scoreNodeParts(node: SessionContextNode, queryTokens: string[], idfByToken: Map<string, number>): RetrievedNodeRanking["reasons"] {
	return {
		query: textMatchScore(queryTokens, idfByToken, node),
		importance: clamp01(node.importance),
		kind: KIND_WEIGHTS[node.kind] ?? 0.5,
	};
}

function finalScore(parts: RetrievedNodeRanking["reasons"]): number {
	return 0.45 * parts.query + 0.30 * parts.importance + 0.25 * parts.kind;
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

	const queryTokens = [...new Set(tokenize(input.query))];
	const idfByToken = queryTokenIdf(queryTokens, graph.nodes);
	const ranked = graph.nodes
		.map((node) => {
			const reasons = scoreNodeParts(node, queryTokens, idfByToken);
			return { node, score: finalScore(reasons), reasons };
		})
		.sort((a, b) => b.score - a.score);
	const candidates = ranked.slice(0, input.candidateNodeLimit);
	const rankedCandidateNodeIds = candidates.map((item) => item.node.id);
	const candidateIds = new Set(rankedCandidateNodeIds);
	const expanded = expandNeighbors(candidateIds, graph, input.expansionHops);
	const scoreById = new Map(ranked.map((r) => [r.node.id, r.score]));
	const orderedExpanded = graph.nodes
		.filter((node) => expanded.has(node.id))
		.sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0));
	const selectedNodes = orderedExpanded.slice(0, input.outputNodeLimit);
	const selectedNodeIds = selectedNodes.map((node) => node.id);
	const selectedSet = new Set(selectedNodeIds);
	const candidateEdgeIds = graph.edges
		.filter((edge) => candidateIds.has(edge.sourceNodeId) && candidateIds.has(edge.targetNodeId))
		.map((edge) => edge.id);

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
		candidateNodeIds: rankedCandidateNodeIds,
		candidateEdgeIds,
		rankedCandidateNodeIds,
		candidateNodeCount: candidates.length,
		ranking: candidates.map((item) => ({ nodeId: item.node.id, score: item.score, reasons: item.reasons })),
		artifacts,
		omitted: {
			nodeCount: Math.max(0, (graph.totalNodes || graph.nodes.length) - selectedNodeIds.length),
			edgeCount: Math.max(0, graph.edges.length - selectedEdgeIds.length),
			reason: graph.truncated || graph.nodes.length > input.outputNodeLimit ? "budget" : "none",
		},
	};
}
