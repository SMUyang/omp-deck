/**
 * Skill-evolution bridge: feeds topology nodes into the skill
 * daily-reflection and skill-evolution pipeline.
 *
 * When the topology-memory extension runs alongside the skill
 * system, topology nodes become the raw material for:
 *   - daily-reflection: "what did we learn today?"
 *   - skill-evolution: "should we create/update a skill?"
 *
 * This module exports a function that collects recent topology
 * nodes and formats them as reflection input.
 */

import type { TopologyNode, TopologyEdge } from "./types.ts";

export interface ReflectionInput {
	/** ISO timestamp of the reflection window start. */
	since: string;
	/** Nodes created or updated since `since`. */
	recentNodes: TopologyNode[];
	/** Edges among recent nodes. */
	recentEdges: TopologyEdge[];
	/** Formatted markdown for the reflection prompt. */
	markdown: string;
}

/**
 * Collect topology nodes from the last N hours and format them
 * as a daily-reflection input block.
 */
export function collectForReflection(
	allNodes: TopologyNode[],
	allEdges: TopologyEdge[],
	hoursBack = 24,
	now = Date.now(),
): ReflectionInput {
	const since = new Date(now - hoursBack * 3_600_000).toISOString();
	const sinceMs = new Date(since).getTime();

	const recentNodes = allNodes.filter((n) => new Date(n.createdAt).getTime() >= sinceMs);
	const recentIds = new Set(recentNodes.map((n) => n.id));
	const recentEdges = allEdges.filter(
		(e) => recentIds.has(e.sourceNodeId) && recentIds.has(e.targetNodeId),
	);

	const markdown = formatReflectionMarkdown(since, recentNodes, recentEdges);
	return { since, recentNodes, recentEdges, markdown };
}

function formatReflectionMarkdown(since: string, nodes: TopologyNode[], edges: TopologyEdge[]): string {
	if (nodes.length === 0) {
		return `# Topology Reflection (${since})\n\nNo topology nodes recorded in this period.`;
	}

	const lines: string[] = [
		`# Topology Reflection (${since})`,
		"",
		`- Total nodes: ${nodes.length}`,
		`- Total edges: ${edges.length}`,
		"",
	];

	// Group by kind for structured review
	const byKind = new Map<string, TopologyNode[]>();
	for (const node of nodes) {
		const bucket = byKind.get(node.kind) ?? [];
		bucket.push(node);
		byKind.set(node.kind, bucket);
	}

	const kindLabels: Record<string, string> = {
		goal: "## Goals",
		user_intent: "## User Intents",
		constraint: "## Constraints",
		decision: "## Decisions",
		resolution: "## Resolutions",
		evidence: "## Evidence",
		issue: "## Issues",
		action: "## Actions",
		handoff_summary: "## Handoff Summaries",
	};

	for (const [kind, label] of Object.entries(kindLabels)) {
		const bucket = byKind.get(kind);
		if (!bucket || bucket.length === 0) continue;
		lines.push(label);
		for (const node of bucket.slice(0, 10)) {
			lines.push(`- [turn ${node.turnIndex}] ${node.title}`);
		}
		if (bucket.length > 10) lines.push(`- ... and ${bucket.length - 10} more`);
		lines.push("");
	}

	// Potential skill candidates: recurring patterns
	const decisions = byKind.get("decision") ?? [];
	if (decisions.length >= 3) {
		lines.push("## Skill Evolution Candidates");
		lines.push("Multiple decisions detected — consider extracting a skill:");
		for (const d of decisions.slice(0, 5)) {
			lines.push(`- ${d.title}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
