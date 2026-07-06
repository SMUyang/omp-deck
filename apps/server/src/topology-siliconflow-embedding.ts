import { buildRerankHttpHeaders } from "./topology-rerank-http-client.ts";

export interface SiliconflowEmbeddingRequest {
	model: string;
	input: string[];
	encoding_format?: "float" | "base64";
}

export interface SiliconflowEmbeddingData {
	object: "embedding";
	embedding: number[];
	index: number;
}

export interface SiliconflowEmbeddingResponse {
	id: string;
	object: "list";
	data: SiliconflowEmbeddingData[];
	usage: { prompt_tokens: number; total_tokens: number };
}

export interface EmbeddingConfig {
	baseUrl: string;
	endpointPath: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function embedTexts(
	config: EmbeddingConfig,
	texts: string[],
): Promise<number[][] | undefined> {
	if (!config.baseUrl || texts.length === 0) return undefined;
	const ep = config.endpointPath || "/embeddings";
	const url = `${config.baseUrl.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
	const headers = buildRerankHttpHeaders({ apiKey: config.apiKey });
	const body: SiliconflowEmbeddingRequest = {
		model: config.model,
		input: texts,
		encoding_format: "float",
	};

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Math.max(1, config.timeoutMs)),
		});
		if (!res.ok) return undefined;
		const raw: unknown = await res.json().catch(() => undefined);
		if (!isRecord(raw)) return undefined;
		const data = raw as unknown as SiliconflowEmbeddingResponse;
		if (!Array.isArray(data.data)) return undefined;
		// Sort by index to guarantee order matches input order
		const sorted = [...data.data].sort((a, b) => a.index - b.index);
		return sorted.map((d) => d.embedding);
	} catch {
		return undefined;
	}
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i];
		const bi = b[i];
		if (ai === undefined || bi === undefined) continue;
		dot += ai * bi;
		normA += ai * ai;
		normB += bi * bi;
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
