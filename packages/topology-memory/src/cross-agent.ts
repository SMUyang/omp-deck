/**
 * Cross-agent memory: shared topology store with agent isolation.
 *
 * Each agent (identified by its extension/source name) has its own
 * namespace in the shared SQLite store. An agent can optionally
 * "borrow" memories from other agents — their top-K nodes by
 * importance become searchable alongside its own.
 *
 * Inspired by TencentDB-Agent-Memory's fixed-asset cross-agent recall.
 */

import type { TopologyNode, RetrievedNode } from "./types.ts";
import { tokenize } from "./retrieve.ts";

const KIND_WEIGHTS: Record<string, number> = {
	resolution: 0.95, decision: 0.92, goal: 0.9, user_intent: 0.88,
	constraint: 0.85, evidence: 0.8, issue: 0.8, action: 0.7, artifact: 0.6,
};

export interface AgentScope {
	agentId: string;
	agentName: string;
}

export interface CrossAgentConfig {
	/** This agent's identity. */
	self: AgentScope;
	/** Other agents to borrow from (max 3 recommended). */
	borrowed: AgentScope[];
	/** How many nodes to borrow per agent. */
	borrowLimit: number;
	/** How many total cross-agent nodes to include in focus. */
	globalTopK: number;
}

/**
 * Build a composite node pool: self nodes + borrowed nodes from other agents.
 * Returns nodes tagged with their source agent for the renderer.
 */
export function buildCrossAgentPool(
	selfNodes: TopologyNode[],
	borrowedNodes: Map<string, TopologyNode[]>,
	config: CrossAgentConfig,
): Array<TopologyNode & { fromAgentId: string; fromAgentName: string }> {
	const pool: Array<TopologyNode & { fromAgentId: string; fromAgentName: string }> = [];

	// Self nodes
	for (const node of selfNodes) {
		pool.push({ ...node, fromAgentId: config.self.agentId, fromAgentName: config.self.agentName });
	}

	// Borrowed nodes (already limited by borrowLimit upstream)
	for (const [agentId, nodes] of borrowedNodes) {
		const scope = config.borrowed.find((b) => b.agentId === agentId);
		if (!scope) continue;
		for (const node of nodes) {
			pool.push({ ...node, fromAgentId: agentId, fromAgentName: scope.agentName });
		}
	}

	return pool;
}

/**
 * Score and select cross-agent nodes for focus injection.
 * Uses the same IDF formula as the main retrieval but adds a
 * cross-agent diversity bonus to avoid one agent dominating.
 */
export function selectCrossAgentFocus(
	query: string,
	pool: Array<TopologyNode & { fromAgentId: string }>,
	globalTopK: number,
): RetrievedNode[] {
	if (pool.length === 0) return [];

	const queryTokens = [...new Set(tokenize(query))];
	const docFreq = new Map<string, number>();
	for (const node of pool) {
		for (const t of new Set(tokenize(`${node.title} ${node.body}`))) {
			docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
		}
	}
	const N = pool.length;

	const scored = pool.map((node) => {
		const nodeTokens = new Set(tokenize(`${node.title} ${node.body}`));
		let matchScore = 0;
		for (const qt of queryTokens) {
			if (nodeTokens.has(qt)) {
				matchScore += Math.log(1 + N / (docFreq.get(qt) ?? 1));
			}
		}
		const normalizedMatch = queryTokens.length > 0 ? matchScore / Math.sqrt(queryTokens.length) : 0;
		const kindWeight = KIND_WEIGHTS[node.kind] ?? 0.7;
		const crossAgentBonus = node.fromAgentId !== pool[0]?.fromAgentId ? 0.05 : 0;
		const finalScore = 0.4 * normalizedMatch + 0.3 * node.importance + 0.2 * kindWeight + 0.1 * (0.5 + crossAgentBonus);
		return { node, score: finalScore, reasons: [`from=${node.fromAgentId}`, `kind=${node.kind}`] };
	});

	// Diversity: ensure at least 1 node from each represented agent
	const byAgent = new Map<string, RetrievedNode[]>();
	for (const s of scored) {
		const key = (s.node as TopologyNode & { fromAgentId: string }).fromAgentId;
		if (!byAgent.has(key)) byAgent.set(key, []);
		byAgent.get(key)!.push(s);
	}

	const result: RetrievedNode[] = [];
	// First pass: top-1 from each agent
	for (const [, agentNodes] of byAgent) {
		if (agentNodes.length > 0) result.push(agentNodes[0]!);
	}
	// Second pass: fill remaining slots by global score
	const remaining = scored
		.filter((s) => !result.includes(s))
		.sort((a, b) => b.score - a.score);
	for (const s of remaining) {
		if (result.length >= globalTopK) break;
		result.push(s);
	}

	return result.slice(0, globalTopK);
}
