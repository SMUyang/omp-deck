/**
 * Memory optimization: merge duplicate nodes, re-score importance,
 * and compact redundant evidence. Runs on agent_end to keep the
 * topology store lean without blocking the conversation.
 */

import type { TopologyNode, TopologyEdge } from "./types.ts";

const SIMILARITY_THRESHOLD = 0.80; // raised from 0.65 — prevents "keep 3" vs "keep 30" merge
const MAX_NODES_PER_SESSION = 500;
const IMPORTANCE_DECAY_DAYS = 30;

/** Detect if two nodes differ only in numbers/versions — never merge these. */
function isParameterVariant(a: string, b: string): boolean {
	const normalize = (s: string) => s.replace(/\d+/g, "#").toLowerCase().trim();
	const na = normalize(a), nb = normalize(b);
	// If normalized forms are identical but originals differ, they're parameter variants
	return na === nb && a !== b;
}

function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter((t) => t.length >= 2);
}

/** Compute Jaccard similarity between two node texts. */
export function nodeSimilarity(a: TopologyNode, b: TopologyNode): number {
	const tokensA = new Set(tokenize(`${a.body} ${a.title}`));
	const tokensB = new Set(tokenize(`${b.body} ${b.title}`));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let intersection = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) intersection++;
	}
	return intersection / (tokensA.size + tokensB.size - intersection);
}

export interface MergeResult {
	merged: TopologyNode[];
	removedIds: Set<string>;
	mergeCount: number;
}

/** Merge near-duplicate nodes (same kind + high text similarity). */
export function mergeDuplicateNodes(nodes: TopologyNode[]): MergeResult {
	const removedIds = new Set<string>();
	const survivors: TopologyNode[] = [];
	let mergeCount = 0;

	for (const node of nodes) {
		let absorbed = false;
		for (let i = 0; i < survivors.length; i++) {
			const existing = survivors[i]!;
		if (existing.kind !== node.kind) continue;
		// Never merge parameter variants (same text, different numbers/versions)
		if (isParameterVariant(existing.title, node.title)) continue;
		if (nodeSimilarity(existing, node) >= SIMILARITY_THRESHOLD) {
				if (node.importance > existing.importance) {
					survivors[i] = {
						...node,
						body: node.body.length >= existing.body.length ? node.body : existing.body,
						importance: Math.max(node.importance, existing.importance),
					};
					removedIds.add(existing.id);
				} else {
					existing.body = existing.body.length >= node.body.length ? existing.body : node.body;
					existing.importance = Math.max(node.importance, existing.importance);
					removedIds.add(node.id);
				}
				mergeCount++;
				absorbed = true;
				break;
			}
		}
		if (!absorbed) survivors.push(node);
	}

	return { merged: survivors, removedIds, mergeCount };
}

/**
 * Decay importance: -10%/week after IMPORTANCE_DECAY_DAYS.
 * Critical kinds (constraint, goal, decision) have a higher floor (0.5)
 * so they survive longer than evidence/action nodes (floor 0.3).
 */
export function decayImportance(nodes: TopologyNode[], now = Date.now()): TopologyNode[] {
	const decayMs = IMPORTANCE_DECAY_DAYS * 86_400_000;
	const weekMs = 7 * 86_400_000;
	const protectedKinds = new Set(["constraint", "goal", "decision"]);
	return nodes.map((node) => {
		const age = now - new Date(node.createdAt).getTime();
		if (age <= decayMs) return node;
		const weeksOver = Math.floor((age - decayMs) / weekMs);
		const floor = protectedKinds.has(node.kind) ? 0.5 : 0.3;
		return { ...node, importance: node.importance * Math.max(floor, 1 - 0.1 * weeksOver) };
	});
}

/** Prune low-importance nodes when exceeding MAX_NODES_PER_SESSION. */
export function pruneExcess(nodes: TopologyNode[], maxNodes = MAX_NODES_PER_SESSION): {
	kept: TopologyNode[];
	prunedIds: Set<string>;
} {
	if (nodes.length <= maxNodes) return { kept: nodes, prunedIds: new Set() };
	const protectedKinds = new Set(["user_intent", "goal"]);
	const protectedNodes = nodes.filter((n) => protectedKinds.has(n.kind));
	const candidates = nodes.filter((n) => !protectedKinds.has(n.kind))
		.sort((a, b) => b.importance - a.importance);
	const keepCount = Math.max(0, maxNodes - protectedNodes.length);
	return {
		kept: [...protectedNodes, ...candidates.slice(0, keepCount)],
		prunedIds: new Set(candidates.slice(keepCount).map((n) => n.id)),
	};
}

export interface OptimizationResult {
	nodes: TopologyNode[];
	removedNodeIds: Set<string>;
	mergedCount: number;
	prunedCount: number;
}

/** Full pipeline: decay → merge → prune. */
export function optimizeTopology(nodes: TopologyNode[], _edges: TopologyEdge[]): OptimizationResult {
	const decayed = decayImportance(nodes);
	const { merged, removedIds: mergedIds, mergeCount } = mergeDuplicateNodes(decayed);
	const { kept, prunedIds } = pruneExcess(merged);
	return {
		nodes: kept,
		removedNodeIds: new Set([...mergedIds, ...prunedIds]),
		mergedCount: mergeCount,
		prunedCount: prunedIds.size,
	};
}
