/**
 * Shared types for the topology-memory engine.
 *
 * These mirror the protocol types from @omp-deck/protocol but are
 * self-contained so the extension can run without importing the
 * full server package.
 */

export type NodeKind =
	| "goal"
	| "user_intent"
	| "constraint"
	| "decision"
	| "action"
	| "artifact"
	| "issue"
	| "resolution"
	| "evidence"
	| "handoff_summary";

export type EdgeRelation =
	| "caused_by"
	| "fixed_by"
	| "resolved_by"
	| "verified_by"
	| "depends_on"
	| "supersedes"
	| "references_file"
	| "continues";

export interface TopologyNode {
	id: string;
	sessionId: string;
	kind: NodeKind;
	messageId: string;
	turnIndex: number;
	title: string;
	body: string;
	importance: number;
	createdAt: string;
	metadata: Record<string, unknown>;
}

export interface TopologyEdge {
	id: string;
	sessionId: string;
	sourceNodeId: string;
	targetNodeId: string;
	relation: EdgeRelation;
	weight: number;
	metadata: Record<string, unknown>;
}

export interface TopologyArtifact {
	id: string;
	sessionId: string;
	nodeId?: string;
	kind: "file" | "commit" | "test" | "command" | "url" | "other";
	ref: string;
	label: string;
}

export interface ExtractedTopology {
	nodes: TopologyNode[];
	edges: TopologyEdge[];
	artifacts: TopologyArtifact[];
}

export interface RetrievedNode {
	node: TopologyNode;
	score: number;
	reasons: string[];
}

export interface RetrievedTopology {
	ranked: RetrievedNode[];
	selectedNodeIds: Set<string>;
	selectedEdgeIds: Set<string>;
	candidateNodeCount: number;
}

export interface FocusRenderOptions {
	nodeLimit: number;
	edgeLimit: number;
	showArtifacts: boolean;
}
