import type { PairRerankPatch, RerankPatch, TopologyPairRerankRequest, TopologyRerankRequest } from "./topology-reranker.ts";
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

export function buildPairDocumentTexts(request: TopologyPairRerankRequest): Array<{ pairId: string; text: string }> {
	return request.candidatePairs.map((pair) => {
		const fields: Array<[string, string | null | undefined]> = [["pair", pair.pairId]];
		for (const [label, main] of [["user", pair.user], ["assistant", pair.assistant]] as const) {
			if (!main) continue;
			fields.push([`${label}.operation`, main.operation], [`${label}.purpose`, main.purpose], [`${label}.title`, main.title], [`${label}.body`, main.body]);
		}
		pair.children.forEach((child, index) => fields.push([`child.${index + 1}.type`, child.childType], [`child.${index + 1}.operation`, child.operation], [`child.${index + 1}.purpose`, child.purpose], [`child.${index + 1}.body`, child.body]));
		return { pairId: pair.pairId, text: fields.filter((field): field is [string, string] => typeof field[1] === "string" && field[1].length > 0).map(([label, value]) => `${label}=${value}`).join("; ").slice(0, 4096) };
	});
}

export function resultsToPairRerankPatch(documentIds: string[], results: SiliconflowRerankResult[], threshold: number): PairRerankPatch | undefined {
	const accepted = results.filter((result) => Number.isInteger(result.index) && result.index >= 0 && result.index < documentIds.length && Number.isFinite(result.relevance_score)).sort((left, right) => right.relevance_score - left.relevance_score || left.index - right.index);
	const keepPairIds: string[] = [];
	for (const result of accepted) { const id = documentIds[result.index]; if (id && result.relevance_score >= threshold && !keepPairIds.includes(id)) keepPairIds.push(id); }
	if (keepPairIds.length === 0) return undefined;
	const keep = new Set(keepPairIds);
	return { keepPairIds, keepChildIds: [], demotePairIds: documentIds.filter((id) => !keep.has(id)) };
}

export async function rerankTopologyPairsWithSiliconflow(options: SiliconflowAdapterOptions & { request: TopologyPairRerankRequest }): Promise<PairRerankPatch | undefined> {
	if (!options.baseUrl) return undefined;
	const docs = buildPairDocumentTexts(options.request);
	const body: SiliconflowRerankRequest = { model: options.model, query: options.request.query, documents: docs.map((item) => item.text), top_n: options.topN ?? Math.max(1, options.request.budget.pairLimit), return_documents: false };
	const ep = options.endpointPath || "/rerank";
	const url = `${options.baseUrl.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
	try {
		const res = await fetch(url, { method: "POST", headers: buildRerankHttpHeaders({ apiKey: options.apiKey, headerName: options.authHeaderName ?? "Authorization" }), body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, options.timeoutMs)) });
		if (!res.ok) return undefined;
		const raw: unknown = await res.json().catch(() => undefined);
		if (!raw || typeof raw !== "object" || !Array.isArray((raw as SiliconflowRerankResponse).results)) return undefined;
		return resultsToPairRerankPatch(docs.map((item) => item.pairId), (raw as SiliconflowRerankResponse).results, options.relevanceThreshold);
	} catch { return undefined; }
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
