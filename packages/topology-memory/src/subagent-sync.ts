/**
 * Subagent memory synchronization.
 *
 * When a parent agent spawns a subagent (via task tool), the subagent
 * inherits a compact topology snapshot from the parent's session.
 * When the subagent finishes, its topology diff is merged back.
 *
 * This ensures subagents start with relevant context without re-reading
 * the entire session JSONL, and their findings propagate upward.
 */

import type { TopologyNode, TopologyEdge, TopologyArtifact } from "./types.ts";

const SUBAGENT_INHERIT_LIMIT = 20;
const SUBAGENT_MERGE_BACK_LIMIT = 10;

/**
 * Select the most important nodes from a parent session to pass
 * to a subagent. Prioritizes goals, decisions, and constraints.
 */
export function selectForSubagent(
	nodes: TopologyNode[],
	edges: TopologyEdge[],
	query?: string,
	limit = SUBAGENT_INHERIT_LIMIT,
): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
	// Priority kinds for subagent context
	const priorityOrder = ["goal", "user_intent", "constraint", "decision", "resolution", "evidence", "issue"];
	const byPriority = new Map<string, TopologyNode[]>();
	for (const node of nodes) {
		const bucket = byPriority.get(node.kind) ?? [];
		bucket.push(node);
		byPriority.set(node.kind, bucket);
	}

	const selected: TopologyNode[] = [];
	// Round-robin by priority until we fill the limit
	let added = true;
	while (added && selected.length < limit) {
		added = false;
		for (const kind of priorityOrder) {
			const bucket = byPriority.get(kind);
			if (!bucket || bucket.length === 0) continue;
			const next = bucket.shift()!;
			selected.push(next);
			added = true;
			if (selected.length >= limit) break;
		}
	}

	const selectedIds = new Set(selected.map((n) => n.id));
	const selectedEdges = edges.filter(
		(e) => selectedIds.has(e.sourceNodeId) && selectedIds.has(e.targetNodeId),
	);

	return { nodes: selected, edges: selectedEdges };
}

/**
 * Render a compact inheritance block for subagent injection.
 * Format: <subagent_context> ... </subagent_context>
 */
export function renderSubagentInheritance(
	parentSessionId: string,
	nodes: TopologyNode[],
	artifacts: TopologyArtifact[],
): string {
	if (nodes.length === 0) return "";

	const lines: string[] = [
		"<subagent_context>",
		`Inherited from parent session ${parentSessionId}:`,
		"",
	];

	for (const node of nodes) {
		lines.push(`[${node.kind}] ${node.title}`);
		if (node.body && node.body !== node.title) {
			lines.push(`  ${node.body.slice(0, 200)}`);
		}
		lines.push("");
	}

	const relevantArtifacts = artifacts.filter((a) => nodes.some((n) => n.id === a.nodeId));
	if (relevantArtifacts.length > 0) {
		lines.push("Artifacts:");
		for (const a of relevantArtifacts.slice(0, 10)) {
			lines.push(`- [${a.kind}] ${a.label}`);
		}
	}

	lines.push("</subagent_context>");
	return lines.join("\n");
}

/**
 * Extract new nodes from a subagent's results that should be
 * merged back into the parent session.
 *
 * Heuristic: select the highest-importance nodes that don't
 * already exist in the parent (by messageId dedup).
 */
export function selectSubagentMergeBack(
	subagentNodes: TopologyNode[],
	parentNodeIds: Set<string>,
	limit = SUBAGENT_MERGE_BACK_LIMIT,
): TopologyNode[] {
	return subagentNodes
		.filter((n) => !parentNodeIds.has(n.id))
		.sort((a, b) => b.importance - a.importance)
		.slice(0, limit);
}
