/**
 * Local embedding — zero-dependency semantic vectors.
 *
 * Uses the hashing trick to create fixed-size vectors from
 * tokenized text. Combines word-level and character n-gram
 * features. Provides cosine similarity without any external
 * API or neural model.
 *
 * Used as a fallback when no third-party embedding (SiliconFlow,
 * etc.) is configured. Always available, runs in microseconds.
 *
 * Limitations vs neural embeddings:
 *   - No cross-lingual mapping (use stemmer + CJK n-grams for that)
 *   - No paraphrase detection
 *   - Sufficient for topology retrieval where tokens are technical terms
 */

import { tokenize } from "./retrieve.ts";

const EMBEDDING_DIMS = 256;

/** Hash a feature string to a vector index. */
function hashIndex(feature: string): number {
	let h = 2166136261;
	for (let i = 0; i < feature.length; i++) {
		h ^= feature.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) % EMBEDDING_DIMS;
}

/** Generate a normalized embedding vector from text. */
export function embedLocal(text: string): Float32Array {
	const vec = new Float32Array(EMBEDDING_DIMS);
	const tokens = tokenize(text);
	if (tokens.length === 0) return vec;

	// Term frequency
	const tf = new Map<string, number>();
	for (const t of tokens) {
		tf.set(t, (tf.get(t) ?? 0) + 1);
	}

	// Hash features with TF weighting + signed hashing (reduces collision noise)
	for (const [token, freq] of tf) {
		const idx = hashIndex(token);
		const sign = (hashIndex(token + "#sign") % 2 === 0) ? 1 : -1;
		vec[idx]! += sign * (freq / tokens.length);
	}

	// L2 normalize
	let norm = 0;
	for (let i = 0; i < EMBEDDING_DIMS; i++) norm += vec[i]! * vec[i]!;
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < EMBEDDING_DIMS; i++) vec[i]! /= norm;
	}

	return vec;
}

/** Cosine similarity between two pre-normalized vectors. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
	return dot; // already L2-normalized → dot product = cosine
}

/**
 * Cache for node embeddings to avoid recomputing on every query.
 * Keyed by node text hash.
 */
const embeddingCache = new Map<string, Float32Array>();

/** Get or compute a cached embedding for a text string. */
export function getCachedEmbedding(text: string): Float32Array {
	let emb = embeddingCache.get(text);
	if (!emb) {
		emb = embedLocal(text);
		if (embeddingCache.size > 10000) embeddingCache.clear(); // bounded
		embeddingCache.set(text, emb);
	}
	return emb;
}

/**
 * Semantic similarity score between query and node text.
 * Returns a value in [0, 1] — higher = more similar.
 */
export function semanticScore(query: string, nodeText: string): number {
	const q = getCachedEmbedding(query);
	const n = getCachedEmbedding(nodeText);
	return Math.max(0, cosineSim(q, n)); // clamp negative to 0
}
