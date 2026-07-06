export type TopologyRerankProvider = "model_role" | "http";

export type TopologyRerankHttpProtocol = "deck-internal" | "siliconflow-rerank";

export interface TopologyRerankHttpConfig {
	baseUrl: string;
	endpointPath: string;
	protocol: TopologyRerankHttpProtocol;
	model: string;
	timeoutMs: number;
	confidenceThreshold: number;
	minCandidateNodes: number;
	minContextPercent: number;
	authHeaderName: string;
}

export interface TopologyRerankConfig {
	enabled: boolean;
	rerankModelRole: string;
	minContextPercent: number;
	minCandidateNodes: number;
	localConfidenceBelow: number;
	timeoutMs: number;
	provider: TopologyRerankProvider;
	http: TopologyRerankHttpConfig;
}
export const DEFAULT_TOPOLOGY_RERANK_HTTP_CONFIG: TopologyRerankHttpConfig = {
	baseUrl: "",
	endpointPath: "/v1/topology/rerank",
	protocol: "deck-internal",
	model: "BAAI/bge-reranker-v2-m3",
	timeoutMs: 30_000,
	confidenceThreshold: 0.72,
	minCandidateNodes: 16,
	minContextPercent: 12,
	authHeaderName: "Authorization",
};

export const DEFAULT_TOPOLOGY_RERANK_CONFIG: TopologyRerankConfig = {
	enabled: true,
	rerankModelRole: "topology_query_reranker",
	minContextPercent: 12,
	minCandidateNodes: 16,
	localConfidenceBelow: 0.72,
	timeoutMs: 30_000,
	provider: "model_role",
	http: { ...DEFAULT_TOPOLOGY_RERANK_HTTP_CONFIG },
};

type EnvLike = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return parsed;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function parseProvider(value: string | undefined): TopologyRerankProvider {
	if (value === "http" || value === "model_role") return value;
	return DEFAULT_TOPOLOGY_RERANK_CONFIG.provider;
}

export function getTopologyRerankConfig(env: EnvLike = process.env): TopologyRerankConfig {
	const defaults = DEFAULT_TOPOLOGY_RERANK_CONFIG;
	const role = env.OMP_DECK_TOPOLOGY_RERANK_ROLE?.trim();
	const confidence = parseNonNegativeNumber(env.OMP_DECK_TOPOLOGY_RERANK_LOCAL_CONFIDENCE_BELOW, defaults.localConfidenceBelow);
	const timeout = parsePositiveInteger(env.OMP_DECK_TOPOLOGY_RERANK_TIMEOUT_MS, defaults.timeoutMs);
	const httpConfidenceRaw = parseNonNegativeNumber(env.OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD, defaults.http.confidenceThreshold);
	const httpConfidence = env.OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD === undefined || Number.isNaN(Number(env.OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD)) ? defaults.http.confidenceThreshold : httpConfidenceRaw;
	const httpTimeout = parsePositiveInteger(env.OMP_DECK_TOPOLOGY_RERANK_HTTP_TIMEOUT_MS, defaults.http.timeoutMs);
	const httpMinNodes = parsePositiveInteger(env.OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CANDIDATE_NODES, defaults.http.minCandidateNodes);
	const httpMinPct = parseNonNegativeNumber(env.OMP_DECK_TOPOLOGY_RERANK_HTTP_MIN_CONTEXT_PERCENT, defaults.http.minContextPercent);
	return {
		enabled: parseBoolean(env.OMP_DECK_TOPOLOGY_RERANK_ENABLED, defaults.enabled),
		rerankModelRole: role ? role : defaults.rerankModelRole,
		minContextPercent: parseNonNegativeNumber(env.OMP_DECK_TOPOLOGY_RERANK_MIN_CONTEXT_PERCENT, defaults.minContextPercent),
		minCandidateNodes: parsePositiveInteger(env.OMP_DECK_TOPOLOGY_RERANK_MIN_CANDIDATE_NODES, defaults.minCandidateNodes),
		localConfidenceBelow: clamp(confidence, 0, 1),
		timeoutMs: clamp(timeout, 1_000, 120_000),
		provider: parseProvider(env.OMP_DECK_TOPOLOGY_RERANK_PROVIDER),
		http: {
			baseUrl: env.OMP_DECK_TOPOLOGY_RERANK_HTTP_BASE_URL ?? defaults.http.baseUrl,
			endpointPath: env.OMP_DECK_TOPOLOGY_RERANK_HTTP_ENDPOINT_PATH ?? defaults.http.endpointPath,
						protocol: (env.OMP_DECK_TOPOLOGY_RERANK_HTTP_PROTOCOL as TopologyRerankHttpProtocol | undefined) ?? defaults.http.protocol,
			model: env.OMP_DECK_TOPOLOGY_RERANK_HTTP_MODEL ?? defaults.http.model,
			timeoutMs: clamp(httpTimeout, 1_000, 120_000),
			confidenceThreshold: (env.OMP_DECK_TOPOLOGY_RERANK_HTTP_CONFIDENCE_THRESHOLD === undefined || httpConfidence > 1) ? defaults.http.confidenceThreshold : httpConfidence,
			minCandidateNodes: httpMinNodes,
			minContextPercent: httpMinPct,
			authHeaderName: env.OMP_DECK_TOPOLOGY_RERANK_HTTP_AUTH_HEADER_NAME ?? defaults.http.authHeaderName,
		},
	};
}
