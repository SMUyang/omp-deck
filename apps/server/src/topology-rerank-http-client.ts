import type { RerankPatch, TopologyRerankRequest } from "./topology-reranker.ts";
import { parseRerankPatch } from "./topology-reranker.ts";

export interface RerankHttpRequest {
	query: string;
	candidateNodes: Array<{ id: string; kind: string; title: string; body: string }>;
	candidateEdges: Array<{ id: string; sourceNodeId: string; relation: string; targetNodeId: string }>;
	budget: { nodeLimit: number; edgeLimit: number };
}

export interface RerankHttpClientOptions {
	baseUrl: string;
	endpointPath: string;
	apiKey: string;
	authHeaderName?: string;
	timeoutMs: number;
	request: TopologyRerankRequest;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function ensureLeadingSlash(value: string): string {
	return value.startsWith("/") ? value : `/${value}`;
}

export function buildRerankHttpRequest(input: RerankHttpRequest): {
	task: "query_rerank";
	query: string;
	candidateNodes: Array<{ id: string; kind: string; title: string; body: string }>;
	candidateEdges: Array<{ id: string; sourceNodeId: string; relation: string; targetNodeId: string }>;
	budget: { nodeLimit: number; edgeLimit: number };
} {
	return {
		task: "query_rerank",
		query: input.query,
		candidateNodes: input.candidateNodes,
		candidateEdges: input.candidateEdges,
		budget: input.budget,
	};
}

export function buildRerankHttpHeaders(options: { apiKey: string; headerName?: string }): Headers {
	const headers = new Headers();
	headers.set("content-type", "application/json");
	if (options.apiKey) {
		const headerName = (options.headerName ?? "Authorization").toLowerCase();
		const headerValue = headerName === "authorization" ? `Bearer ${options.apiKey}` : options.apiKey;
		headers.set(headerName, headerValue);
	}
	return headers;
}

export function parseRerankHttpResponse(raw: unknown): RerankPatch | undefined {
	return parseRerankPatch(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonSafe(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
}

export async function rerankTopologyWithHttp(options: RerankHttpClientOptions): Promise<RerankPatch | undefined> {
	if (!options.baseUrl) return undefined;
	const url = `${trimTrailingSlash(options.baseUrl)}${ensureLeadingSlash(options.endpointPath || "/v1/topology/rerank")}`;
	const headers = buildRerankHttpHeaders({ apiKey: options.apiKey, headerName: options.authHeaderName });
	const body = buildRerankHttpRequest({
		query: options.request.query,
		candidateNodes: options.request.candidateNodes,
		candidateEdges: options.request.candidateEdges,
		budget: options.request.budget,
	});

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Math.max(1, options.timeoutMs)),
		});
		if (!res.ok) return undefined;
		const raw = await readJsonSafe(res);
		if (!isRecord(raw) && !Array.isArray(raw)) return undefined;
		return parseRerankHttpResponse(raw);
	} catch {
		return undefined;
	}
}
