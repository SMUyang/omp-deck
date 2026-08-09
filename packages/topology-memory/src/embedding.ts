/**
 * Embedding provider — tiered fallback: API → local.
 *
 * When a third-party embedding API (SiliconFlow, OpenAI, etc.) is configured,
 * it is used as the primary embedding source. If the API call fails (timeout,
 * rate limit, network error), the local embedding is used as fallback.
 *
 * When no API is configured, local embedding is used directly.
 *
 * Config (read from env, same as deck server):
 *   OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED=1
 *   OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
 *   OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY=sk-xxx
 *   OMP_DECK_TOPOLOGY_EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5
 *   OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH=/embeddings
 *   OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS=30000
 */

import { embedLocal, getCachedEmbedding, cosineSim, semanticScore as localSemanticScore } from "./local-embedding.ts";

export interface ApiEmbeddingConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	endpointPath: string;
	timeoutMs: number;
}

/** Detect if a third-party embedding API is configured. */
export function getApiEmbeddingConfig(): ApiEmbeddingConfig | undefined {
	const enabled = process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENABLED;
	const baseUrl = process.env.OMP_DECK_TOPOLOGY_EMBEDDING_BASE_URL;
	const apiKey = process.env.OMP_DECK_TOPOLOGY_EMBEDDING_API_KEY;
	if (!enabled || enabled.trim() === "0" || !baseUrl || !apiKey) return undefined;
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		model: process.env.OMP_DECK_TOPOLOGY_EMBEDDING_MODEL ?? "BAAI/bge-large-zh-v1.5",
		endpointPath: process.env.OMP_DECK_TOPOLOGY_EMBEDDING_ENDPOINT_PATH ?? "/embeddings",
		timeoutMs: Number(process.env.OMP_DECK_TOPOLOGY_EMBEDDING_TIMEOUT_MS) || 30_000,
	};
}

/** Cache for API embeddings (node text → vector). Bounded. */
const apiEmbeddingCache = new Map<string, Float32Array>();
const API_CACHE_LIMIT = 5000;
let apiFailureCount = 0;
const API_FAILURE_THRESHOLD = 3; // after 3 failures, skip API for this session

/** Call the API embedding endpoint. Returns undefined on failure. */
async function embedViaApi(texts: string[], config: ApiEmbeddingConfig): Promise<Float32Array[] | undefined> {
	if (apiFailureCount >= API_FAILURE_THRESHOLD) return undefined;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		const resp = await fetch(`${config.baseUrl}${config.endpointPath}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({ model: config.model, input: texts }),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!resp.ok) {
			apiFailureCount++;
			return undefined;
		}
		const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
		if (!data.data?.length) {
			apiFailureCount++;
			return undefined;
		}
		apiFailureCount = 0; // reset on success
		return data.data.map((d) => Float32Array.from(d.embedding ?? []));
	} catch {
		apiFailureCount++;
		return undefined;
	}
}

/**
 * Get embedding for a single text — tiered fallback.
 * 1. Check API cache (if API configured)
 * 2. Try API (if configured and not in failure cooldown)
 * 3. Fall back to local embedding
 */
export async function getEmbedding(text: string): Promise<Float32Array> {
	const config = getApiEmbeddingConfig();

	// Try API first (if configured)
	if (config) {
		const cached = apiEmbeddingCache.get(text);
		if (cached) return cached;

		const [result] = (await embedViaApi([text], config)) ?? [];
		if (result) {
			if (apiEmbeddingCache.size >= API_CACHE_LIMIT) {
				const firstKey = apiEmbeddingCache.keys().next().value;
				if (firstKey) apiEmbeddingCache.delete(firstKey);
			}
			apiEmbeddingCache.set(text, result);
			return result;
		}
	}

	// Fallback: local embedding
	return getCachedEmbedding(text);
}

/**
 * Batch embed multiple texts — API first, local fallback.
 */
export async function getEmbeddings(texts: string[]): Promise<Float32Array[]> {
	const config = getApiEmbeddingConfig();

	if (config) {
		// Separate cached vs uncached
		const results: (Float32Array | undefined)[] = texts.map((t) => apiEmbeddingCache.get(t));
		const uncachedIndices: number[] = [];
		const uncachedTexts: string[] = [];
		for (let i = 0; i < texts.length; i++) {
			if (!results[i]) {
				uncachedIndices.push(i);
				uncachedTexts.push(texts[i]!);
			}
		}
		if (uncachedTexts.length > 0) {
			const apiResults = (await embedViaApi(uncachedTexts, config)) ?? [];
			for (let i = 0; i < uncachedIndices.length; i++) {
				const apiResult = apiResults[i];
				const idx = uncachedIndices[i]!;
				if (apiResult) {
					results[idx] = apiResult;
					if (apiEmbeddingCache.size >= API_CACHE_LIMIT) {
						const firstKey = apiEmbeddingCache.keys().next().value;
						if (firstKey) apiEmbeddingCache.delete(firstKey);
					}
					apiEmbeddingCache.set(uncachedTexts[i]!, apiResult);
				}
			}
		}
		// Fill any remaining gaps with local
		return results.map((r, i) => r ?? getCachedEmbedding(texts[i]!));
	}

	// No API configured — all local
	return texts.map((t) => getCachedEmbedding(t));
}

/** Cosine similarity (works for both API and local embeddings). */
export { cosineSim, localSemanticScore };

/**
 * Synchronous semantic score — uses local embedding only.
 * For async API-aware scoring, use getEmbedding + cosineSim.
 */
export function semanticScore(query: string, nodeText: string): number {
	return localSemanticScore(query, nodeText);
}

export { tokenizeCache, clearTokenizeCache } from "./local-embedding.ts";
