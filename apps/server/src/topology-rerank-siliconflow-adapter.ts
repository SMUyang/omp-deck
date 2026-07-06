import type { RerankPatch, TopologyRerankRequest } from "./topology-reranker.ts";
import { buildRerankHttpHeaders } from "./topology-rerank-http-client.ts";

export interface SiliconflowRerankRequest {
	model: string;
	query: string;
	documents: string[];
	top_n?: number;
	return_documents?: boolean;
}

export interface SiliconflowRerankResult {
	index: number;
	relevance_score: number;
}

export interface SiliconflowRerankResponse {
	id: string;
	results: SiliconflowRerankResult[];
}

export interface SiliconflowAdapterOptions {
	baseUrl: string;
	endpointPath?: string;
	apiKey: string;
	authHeaderName?: string;
	timeoutMs: number;
	model: string;
	relevanceThreshold: number;
	topN?: number;
}

function buildDocumentTexts(request: TopologyRerankRequest): Array<{ id: string; text: string }> {
	return request.candidateNodes.map((node) => ({
		id: node.id,
		text: `${node.kind}: ${node.title} — ${node.body}`.slice(0, 512),
	}));
}

function readJsonSafe(raw: unknown): unknown {
	try {
		if (typeof raw === "string") return JSON.parse(raw);
		return raw;
	} catch {
		return undefined;
	}
}

function resultsToRerankPatch(
	documentIds: string[],
	results: SiliconflowRerankResult[],
	threshold: number,
): RerankPatch {
	const keepNodeIds: string[] = [];
	const demoteNodeIds: string[] = [];
	const scored = new Map<number, number>();
	for (const r of results) {
		scored.set(r.index, r.relevance_score);
	}
	for (let i = 0; i < documentIds.length; i++) {
		const score = scored.get(i) ?? 0;
		const id = documentIds[i];
		if (!id) continue;
		if (score >= threshold) {
			keepNodeIds.push(id);
		} else {
			demoteNodeIds.push(id);
		}
	}
	// Keep all edges from kept nodes, demote edges that reference demoted nodes
	const keepSet = new Set(keepNodeIds);
	const keepEdgeIds: string[] = [];
	return { keepNodeIds, keepEdgeIds, demoteNodeIds };
}

export async function rerankTopologyWithSiliconflow(
	options: SiliconflowAdapterOptions & { request: TopologyRerankRequest },
): Promise<RerankPatch | undefined> {
	if (!options.baseUrl) return undefined;
	const docs = buildDocumentTexts(options.request);
	const documentIds = docs.map((d) => d.id);
	const documents = docs.map((d) => d.text);

	const body: SiliconflowRerankRequest = {
		model: options.model,
		query: options.request.query,
		documents,
		top_n: options.topN ?? Math.max(1, options.request.budget.nodeLimit),
		return_documents: false,
	};

	const ep = options.endpointPath || "/rerank";
	const url = `${options.baseUrl.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
	const headers = buildRerankHttpHeaders({ apiKey: options.apiKey, headerName: options.authHeaderName ?? "Authorization" });

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Math.max(1, options.timeoutMs)),
		});
		if (!res.ok) return undefined;
		const raw: unknown = await res.json().catch(() => undefined);
		if (!raw || typeof raw !== "object") return undefined;
		const data = raw as SiliconflowRerankResponse;
		if (!Array.isArray(data.results)) return undefined;
		return resultsToRerankPatch(documentIds, data.results, options.relevanceThreshold);
	} catch {
		return undefined;
	}
}
