/**
 * V3 Topology Retrieval Pipeline.
 *
 * Pipeline:
 *   query → detectIntent → retrieveCandidates → expandWeighted
 *         → rerank → noAnswerGate → selectBudgeted → renderStructured
 *
 * Key V3 improvements over V2:
 *   - Query intent detection (current_state, historical, resolution, artifact, general)
 *   - State-aware reranking (active/stale via supersession edges)
 *   - Relation-aware reranking (resolved_by, supersedes, implements boost)
 *   - Budget-aware focus selection (slot allocation by category)
 *   - No-answer gate (confidence threshold for negative queries)
 *   - Weighted graph expansion (edge-type-aware, not flat BFS)
 *   - Char 3-gram in addition to bigram for CJK matching
 */

import type { TopologyNode, TopologyEdge, TopologyArtifact, RetrievedTopology, RetrievedNode } from "./types.ts";
import { semanticScore, tokenizeCache, clearTokenizeCache } from "./embedding.ts";

// ── Constants ───────────────────────────────────────────────────────────

const KIND_WEIGHTS: Record<string, number> = {
	resolution: 0.95, decision: 0.92, goal: 0.9, user_intent: 0.88,
	constraint: 0.85, handoff_summary: 0.85, evidence: 0.8, issue: 0.8,
	action: 0.7, artifact: 0.6,
};

const STOPWORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "must", "can", "this", "that", "these", "those",
	"i", "you", "he", "she", "it", "we", "they", "what", "which", "who",
	"and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
	"from", "as", "into", "about", "than", "then", "so", "if", "because",
	"的", "了", "吗", "呢", "吧", "是", "在", "有", "和", "与", "或", "但",
	"这", "那", "个", "我", "你", "他", "她", "它", "就", "都", "也", "很",
]);

// ── Edge relation weights for weighted expansion ───────────────────────

const RELATION_WEIGHTS: Record<string, number> = {
	resolved_by: 1.0, supersedes: 0.95, fixed_by: 0.95,
	verified_by: 0.85, implements: 0.85,
	caused_by: 0.75, depends_on: 0.70, produces: 0.70,
	continues: 0.50, references_file: 0.40, contradicts: 0.30,
};

// ── Tokenization ────────────────────────────────────────────────────────

export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	const segments = lower.split(/([^a-z0-9\u4e00-\u9fff]+)/u);
	for (const seg of segments) {
		if (!seg || !seg.trim()) continue;
		const cjkChars = seg.match(/[\u4e00-\u9fff]/gu);
		if (cjkChars && cjkChars.length === seg.length) {
			// CJK: char bigrams + trigrams
			for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
			for (let i = 0; i < seg.length - 2; i++) tokens.push(seg.slice(i, i + 3));
			if (seg.length <= 3) tokens.push(seg);
			continue;
		}
		if (/^[a-z][a-z0-9]*$/.test(seg) && seg.length >= 2 && !STOPWORDS.has(seg)) {
			tokens.push(stem(seg));
		}
	}
	return tokens;
}

/** Simple English stemmer for cross-form matching. */
function stem(word: string): string {
	return word
		.replace(/(retrieval|retrieving|retrieved|retrieve)$/i, "retriev")
		.replace(/(tion|sion)$/i, "t")
		.replace(/(ing|ed)$/i, "")
		.replace(/(al|er|ors?)$/i, "")
		.replace(/(e|es)$/i, "");
}

function nodeText(node: TopologyNode): string {
	return `${node.title} ${node.body}`;
}

// ── Query Intent Detection ──────────────────────────────────────────────

export type QueryIntent = "current_state" | "historical" | "resolution" | "artifact" | "general";

export function detectQueryIntent(q: string): QueryIntent {
	if (/(?:当前|现在|最终|目前|现在用|current|currently|final|active)/i.test(q)) return "current_state";
	if (/(?:最初|之前|原来|曾经|历史|开始时|最开始|initial|original|previous|history)/i.test(q)) return "historical";
	if (/(?:怎么解决|如何解决|修复|解决方案|怎么修|fix|resolve|solution|怎么处理)/i.test(q)) return "resolution";
	if (/(?:哪个文件|什么文件|文件在哪|file|module|哪个模块)/i.test(q)) return "artifact";
	return "general";
}

/** Relation weight for topology propagation. Boosts resolved_by when query asks about fixing. */
function relationWeight(relation: string, query: string): number {
	if (relation === "resolved_by" && /解决|修复|怎么修|resolve|fix|solution/i.test(query)) return 1.0;
	switch (relation) {
		case "resolved_by": return 0.8;
		case "verified_by": return 0.55;
		case "supersedes": return 0.65;
		case "depends_on": return 0.35;
		case "continues": return 0.2;
		default: return 0.15;
	}
}

function selectEdges(edges: TopologyEdge[], nodeIds: Set<string>): Set<string> {
	const selected = new Set<string>();
	for (const edge of edges) {
		if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
			selected.add(edge.id);
		}
	}
	return selected;
}

export function retrieveTopology(
	query: string,
	nodes: TopologyNode[],
	edges: TopologyEdge[],
	options: { candidateLimit?: number; outputLimit?: number; expansionHops?: 1 | 2 } = {},
): RetrievedTopology {
	const candidateLimit = options.candidateLimit ?? 100;
	const outputLimit = options.outputLimit ?? 40;

	if (nodes.length === 0) {
		return { ranked: [], selectedNodeIds: new Set(), selectedEdgeIds: new Set(), candidateNodeCount: 0 };
	}

	// Step 1: Build supersession map + active leaves
	const supersededNodeIds = new Set<string>();
	const activeLeafIds = new Set<string>();
	for (const edge of edges) {
		if (edge.relation === "supersedes") {
			supersededNodeIds.add(edge.targetNodeId);
			activeLeafIds.add(edge.sourceNodeId);
		}
	}
	// A node that is BOTH source and target is a chain middle — not a leaf
	for (const id of supersededNodeIds) activeLeafIds.delete(id);

	// Step 2: IDF scoring (V2-simple, with CJK 3-gram + stemmer)
	const queryTokens = [...new Set(tokenize(query))];

	if (queryTokens.length === 0) {
		const sorted = [...nodes].sort((a, b) => b.importance - a.importance).slice(0, outputLimit);
		return {
			ranked: sorted.map((node) => ({ node, score: node.importance, reasons: ["importance"] })),
			selectedNodeIds: new Set(sorted.map((n) => n.id)),
			selectedEdgeIds: selectEdges(edges, new Set(sorted.map((n) => n.id))),
			candidateNodeCount: nodes.length,
		};
	}

	const docFreq = new Map<string, number>();
	const nodeTokensCache = new Map<string, Set<string>>();
	for (const node of nodes) {
		const text = nodeText(node);
		const tokens = new Set(tokenizeCache(text, tokenize));
		nodeTokensCache.set(node.id, tokens);
		for (const t of tokens) {
			docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
		}
	}
	const N = nodes.length;

	const scored: RetrievedNode[] = nodes.map((node) => {
		const tokenSet = nodeTokensCache.get(node.id)!;
		let matchScore = 0;
		const reasons: string[] = [];
		for (const qt of queryTokens) {
			if (tokenSet.has(qt)) {
				const idf = Math.log(1 + N / (docFreq.get(qt) ?? 1));
				matchScore += idf;
				reasons.push(`[match] ${qt}`);
			}
		}
		const normalizedMatch = matchScore / Math.sqrt(queryTokens.length);
		const semScore = semanticScore(query, nodeText(node));
		const blendedMatch = 0.65 * normalizedMatch + 0.35 * semScore;
		const kindWeight = KIND_WEIGHTS[node.kind] ?? 0.7;
		let finalScore = 0.45 * blendedMatch + 0.30 * node.importance + 0.25 * kindWeight;

		// V3.1c: active supersession leaf boost (the CURRENT state)
		if (activeLeafIds.has(node.id)) {
			finalScore *= 1.20;
			reasons.push("[active-leaf] ×1.20");
		}

		// V3 targeted: supersession penalty (×0.1 for stale nodes)
		if (supersededNodeIds.has(node.id)) {
			finalScore *= 0.1;
			reasons.push("[superseded] ×0.1");
		}

		return { node, score: finalScore, reasons: reasons.length > 0 ? reasons : [`kind=${node.kind}`, `importance=${node.importance}`] };
	});

	const candidates = scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);

	// V3.1c: inject active supersession leaves into candidates even with zero lexical match.
	// The current state is structurally important regardless of query wording.
	if (activeLeafIds.size > 0) {
		for (const node of nodes) {
			if (!activeLeafIds.has(node.id)) continue;
			if (scored.some((r) => r.node.id === node.id && r.score > 0)) continue;
			const kindWeight = KIND_WEIGHTS[node.kind] ?? 0.7;
			const baseScore = 0.30 * node.importance + 0.25 * kindWeight;
			scored.push({ node, score: baseScore * 1.2, reasons: ["[active-leaf injected]"] });
		}
	}

	// Step 3: Topology propagation — follow edges from top candidates,
	// propagate score via relationWeight. Uses max(original, propagated)
	// so topology gives AT LEAST this relevance without inflating scores.
	const candidateMap = new Map(candidates.map((r) => [r.node.id, r]));
	for (const seed of candidates.slice(0, outputLimit)) {
		for (const edge of edges) {
			let targetId: string | undefined;
			if (edge.sourceNodeId === seed.node.id) targetId = edge.targetNodeId;
			else if (edge.targetNodeId === seed.node.id) targetId = edge.sourceNodeId;
			if (!targetId) continue;

			const weight = relationWeight(edge.relation, query);
			if (weight <= 0.15) continue; // skip weak relations for propagation
			const propagated = seed.score * weight;

			const existing = candidateMap.get(targetId);
			if (!existing) {
				const targetNode = nodes.find((n) => n.id === targetId);
				if (targetNode) candidateMap.set(targetId, { node: targetNode, score: propagated, reasons: [`[propagated:${edge.relation}]`] });
			} else if (propagated > existing.score) {
				existing.score = propagated;
				existing.reasons.push(`[propagated:${edge.relation}] ${propagated.toFixed(2)}`);
			}
		}
	}

	// Step 4: Simple sort + slice (V2 approach — proven flat curve)
	const selected = [...candidateMap.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, outputLimit);

	// V3.1c: active supersession leaves are structurally mandatory in the focus.
	// The current state must always be visible, regardless of lexical ranking.
	const selectedSet = new Set(selected.map((r) => r.node.id));
	for (const id of activeLeafIds) {
		const node = candidateMap.get(id);
		if (node && !selectedSet.has(id)) {
			selected.push(node);
			selectedSet.add(id);
		}
	}

	const selectedNodeIds = new Set(selected.map((r) => r.node.id));
	const selectedEdgeIds = selectEdges(edges, selectedNodeIds);

	return { ranked: selected, selectedNodeIds, selectedEdgeIds, candidateNodeCount: candidates.length };
}

// ── V3.2 Open-set Memory Retrieval ──────────────────────────────────────

export type MemoryStatus = "supported" | "contradicted" | "unknown";

/** Extract named entities from query: capitalized words ≥4 chars + known tech terms. */
function extractEntities(text: string): string[] {
	const entities: string[] = [];
	// Capitalized words (English) ≥4 chars
	for (const m of text.matchAll(/\b([A-Z][a-zA-Z]{3,})\b/g)) {
		const word = m[1]!.toLowerCase();
		if (!STOPWORDS.has(word) && word.length >= 4) entities.push(word);
	}
	// Known tech identifiers in any case
	for (const m of text.matchAll(/\b(kubernetes|docker|sqlite|postgres|parquet|csv|rust|python|react|mongodb|redis|grafana|prometheus)\b/gi)) {
		entities.push(m[0]!.toLowerCase());
	}
	return [...new Set(entities)];
}

/** Check if any query entity appears in superseded nodes (contradiction signal). */
function detectContradiction(
	query: string,
	ranked: RetrievedNode[],
	edges: TopologyEdge[],
): boolean {
	const entities = extractEntities(query);
	if (entities.length === 0) return false;

	const supersededIds = new Set<string>();
	for (const edge of edges) {
		if (edge.relation === "supersedes") supersededIds.add(edge.targetNodeId);
	}

	// Check: does any superseded node contain the query entity?
	for (const r of ranked) {
		if (!supersededIds.has(r.node.id)) continue;
		const nodeLower = nodeText(r.node).toLowerCase();
		if (entities.some((e) => nodeLower.includes(e))) return true;
	}
	return false;
}

/** Compute open-set confidence for the top candidate. */
function computeOpenSetConfidence(
	query: string,
	ranked: RetrievedNode[],
): { status: MemoryStatus; confidence: number } {
	if (ranked.length === 0) return { status: "unknown", confidence: 0 };

	const top1 = ranked[0]!;
	const top2 = ranked[1];
	const top1Score = top1.score;
	const margin = top2 ? top1Score - top2.score : top1Score;

	// Query token coverage of top node
	const queryTokens = new Set(tokenize(query));
	const nodeTokens = new Set(tokenize(nodeText(top1.node)));
	const queryCoverage = queryTokens.size > 0
		? [...queryTokens].filter((t) => nodeTokens.has(t)).length / queryTokens.size
		: 1;

	// Entity coverage: critical identifiers must appear in top candidates
	const entities = extractEntities(query);
	let entityCoverage = 1;
	if (entities.length > 0) {
		const allCandidateText = ranked.slice(0, 5).map((r) => nodeText(r.node).toLowerCase()).join(" ");
		const matched = entities.filter((e) => allCandidateText.includes(e)).length;
		entityCoverage = matched / entities.length;
	}

	const confidence = 0.45 * Math.min(1, top1Score) + 0.25 * queryCoverage + 0.20 * entityCoverage + 0.10 * Math.min(1, margin);

	// If a key entity has ZERO coverage, strong UNKNOWN signal
	if (entities.length > 0 && entityCoverage === 0) {
		return { status: "unknown", confidence };
	}

	// Conservative threshold: only mark UNKNOWN if confidence is very low
	if (confidence < 0.30) {
		return { status: "unknown", confidence };
	}

	return { status: "supported", confidence };
}

export function renderFocus(
	sessionId: string,
	query: string,
	retrieved: RetrievedTopology,
	artifacts: TopologyArtifact[],
	options: { showArtifacts?: boolean; edges?: TopologyEdge[] } = {},
): string {
	if (retrieved.ranked.length === 0) {
		return "<topology_focus status=\"unknown\"/>\n";
	}

	// V3.2: Open-set three-state detection
	const edges = options.edges ?? [];
	const isContradicted = detectContradiction(query, retrieved.ranked, edges);
	const { status: rawStatus, confidence } = computeOpenSetConfidence(query, retrieved.ranked);
	const status: MemoryStatus = isContradicted ? "contradicted" : rawStatus;

	if (status === "unknown") {
		return `<topology_focus status="unknown" confidence="${confidence.toFixed(2)}"/>\n`;
	}

	const intent = detectQueryIntent(query);
	const lines: string[] = [`<topology_focus status="${status}" confidence="${confidence.toFixed(2)}">`];
	lines.push(`Intent: ${intent}`);
	lines.push(`Query: ${query.slice(0, 200)}`);
	lines.push(`Nodes: ${retrieved.ranked.length} (of ${retrieved.candidateNodeCount} candidates)`);
	if (status === "contradicted") lines.push("Note: query entity found in superseded memory — current state may differ.");
	lines.push("");

	const byKind = new Map<string, RetrievedNode[]>();
	for (const r of retrieved.ranked) {
		const bucket = byKind.get(r.node.kind) ?? [];
		bucket.push(r);
		byKind.set(r.node.kind, bucket);
	}

	const kindLabels: Record<string, string> = {
		goal: "Goals", constraint: "Constraints", decision: "Decisions",
		resolution: "Resolutions", issue: "Issues", evidence: "Evidence",
		action: "Actions", user_intent: "Context", handoff_summary: "Summary",
		artifact: "Artifacts",
	};

	for (const [kind, label] of Object.entries(kindLabels)) {
		const bucket = byKind.get(kind);
		if (!bucket || bucket.length === 0) continue;
		lines.push(`<${label}>`);
		for (const { node } of bucket) {
			const reasons = bucket.find((r) => r.node.id === node.id)?.reasons ?? [];
			const staleTag = reasons.some((r) => r.includes("stale") || r.includes("superseded")) ? " [STALE]" : "";
			lines.push(`- [${node.kind}]${staleTag} ${node.title}`);
			if (node.body && node.body !== node.title) {
				lines.push(`  ${node.body.slice(0, 200)}`);
			}
		}
		lines.push(`</${label}>`);
		lines.push("");
	}

	if (options.showArtifacts && artifacts.length > 0) {
		const nodeIds = retrieved.selectedNodeIds;
		const relevant = artifacts.filter((a) => !a.nodeId || nodeIds.has(a.nodeId));
		if (relevant.length > 0) {
			lines.push("<Artifacts>");
			for (const a of relevant.slice(0, 20)) {
				lines.push(`- [${a.kind}] ${a.label}`);
			}
			lines.push("</Artifacts>");
		}
	}

	lines.push("</topology_focus>");
	return lines.join("\n");
}
