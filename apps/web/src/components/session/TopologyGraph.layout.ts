import type {
	SessionContextEdge,
	SessionContextEdgeRelation,
	SessionContextNode,
} from "@omp-deck/protocol";

const LEGACY_LANE_ORDER = [
	"goal",
	"user_intent",
	"decision",
	"constraint",
	"action",
	"resolution",
	"issue",
	"evidence",
	"artifact",
	"todo_state",
	"handoff_summary",
] as const;

const EDGE_STYLE: Record<string, TopologyEdgeVisualStyle> = {
	answers: { dash: "0", color: "stroke-accent", width: 2.2 },
	caused_by: { dash: "0", color: "stroke-accent/40", width: 1 },
	fixed_by: { dash: "0", color: "stroke-success/50", width: 1.1 },
	verified_by: { dash: "0", color: "stroke-success/40", width: 1 },
	depends_on: { dash: "0", color: "stroke-ink-3/45", width: 0.9 },
	continues: { dash: "0", color: "stroke-accent-soft/50", width: 1 },
	references_file: { dash: "0", color: "stroke-ink-3/30", width: 0.8 },
	blocks: { dash: "4 3", color: "stroke-danger/55", width: 1.1 },
	contradicts: { dash: "4 3", color: "stroke-danger/55", width: 1.1 },
	supersedes: { dash: "1 3", color: "stroke-thinking/55", width: 1 },
	summarizes: { dash: "1 3", color: "stroke-thinking/55", width: 1 },
};

export interface TopologyNodePosition {
	x: number;
	y: number;
	lane: string;
	depth: number;
	parentNodeId?: string;
}

export interface TopologyNodeLayout {
	positions: Map<string, TopologyNodePosition>;
	lanes: Array<{ kind: string; x: number; width: number }>;
	width: number;
	height: number;
}

export interface TopologyEdgeVisualStyle {
	dash: string;
	color: string;
	width: number;
}

export interface TopologyNodeDetail {
	key: string;
	labelKey: string;
	value: string | number;
	valueKey?: string;
}

export function computeTopologyNodeLayout(
	nodes: ReadonlyArray<SessionContextNode>,
	_edges: ReadonlyArray<SessionContextEdge>,
	width: number,
	height: number,
): TopologyNodeLayout {
	if (nodes.length === 0) return { positions: new Map(), lanes: [], width, height };
	const hasV2Nodes = nodes.some((node) => node.population != null || node.nodeRole != null || node.parentNodeId != null);
	return hasV2Nodes
		? computeConversationalLayout(nodes, width, height)
		: computeLegacyLayout(nodes, width, height);
}

export function topologyEdgeStyle(relation: SessionContextEdgeRelation): TopologyEdgeVisualStyle {
	return EDGE_STYLE[relation] ?? { dash: "0", color: "stroke-ink-3/30", width: 0.8 };
}

export function topologyInspectorCopyKey(
	selectedNodeId: string | null,
	nodeExists: boolean,
): "topologyWorkspace.graph.inspectHint" | "topologyWorkspace.graph.nodeNotFound" | null {
	if (nodeExists) return null;
	return selectedNodeId
		? "topologyWorkspace.graph.nodeNotFound"
		: "topologyWorkspace.graph.inspectHint";
}

export function topologyNodeDetails(node: SessionContextNode): TopologyNodeDetail[] {
	const details: TopologyNodeDetail[] = [];
	pushSemanticDetail(details, "population", node.population);
	pushSemanticDetail(details, "nodeRole", node.nodeRole);
	pushSemanticDetail(details, "origin", node.origin);
	pushSemanticDetail(details, "childType", node.childType);
	pushSemanticDetail(details, "operation", node.operation);
	pushDetail(details, "operationDetail", node.operationDetail);
	pushDetail(details, "purpose", node.purpose);
	pushDetail(details, "refinedPurpose", node.refinedPurpose);
	if (node.refinement) {
		details.push({
			key: "refinementProvenance",
			labelKey: "topologyWorkspace.details.refinementProvenance",
			value: `${node.refinement.model} · ${node.refinement.promptVersion}`,
		});
		pushDetail(details, "refinementModel", node.refinement.model);
		pushDetail(details, "refinementPromptVersion", node.refinement.promptVersion);
	}
	pushSemanticDetail(details, "status", node.status);
	pushDetail(details, "pairId", node.pairId);
	pushDetail(details, "parentNodeId", node.parentNodeId);
	pushDetail(details, "sourceTurnIndex", node.sourceTurnIndex);
	pushDetail(details, "importance", node.importance);
	return details;
}

function computeConversationalLayout(
	nodes: ReadonlyArray<SessionContextNode>,
	width: number,
	height: number,
): TopologyNodeLayout {
	const positions = new Map<string, TopologyNodePosition>();
	const marginX = Math.min(96, Math.max(48, width * 0.1));
	const userX = clamp(width * 0.28, marginX, width - marginX);
	const assistantX = clamp(width * 0.72, marginX, width - marginX);
	const lanes = [
		{ kind: "user", x: userX, width: width * 0.44 },
		{ kind: "assistant", x: assistantX, width: width * 0.44 },
	];
	const mains = stableNodes(nodes.filter((node) => node.nodeRole !== "child"));
	const mainById = new Map(mains.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, SessionContextNode[]>();
	const orphans: SessionContextNode[] = [];
	for (const node of nodes) {
		if (node.nodeRole !== "child") continue;
		if (node.parentNodeId && mainById.has(node.parentNodeId)) {
			const siblings = childrenByParent.get(node.parentNodeId) ?? [];
			siblings.push(node);
			childrenByParent.set(node.parentNodeId, siblings);
		} else {
			orphans.push(node);
		}
	}
	for (const siblings of childrenByParent.values()) siblings.sort(compareNodes);
	orphans.sort(compareNodes);

	const maxChildren = Math.max(0, ...Array.from(childrenByParent.values(), (children) => children.length));
	const childColumns = Math.max(1, Math.min(4, maxChildren));
	const childRows = maxChildren > 0 ? Math.ceil(maxChildren / childColumns) : 0;
	const groupHeight = Math.max(92, 62 + childRows * 48);
	const orphanRows = orphans.length > 0 ? Math.ceil(orphans.length / 4) : 0;
	const contentHeight = Math.max(height, 42 + mains.length * groupHeight + orphanRows * 48 + 42);

	mains.forEach((node, index) => {
		const lane = node.population === "user" ? "user" : "assistant";
		const x = lane === "user" ? userX : assistantX;
		const y = clamp(48 + index * groupHeight, 24, contentHeight - 24);
		positions.set(node.id, { x, y, lane, depth: 0 });
		const children = childrenByParent.get(node.id) ?? [];
		placeChildGrid(positions, children, {
			parentNodeId: node.id,
			parentX: x,
			parentY: y,
			lane: "assistant",
			width,
			height: contentHeight,
		});
	});

	if (orphans.length > 0) {
		const startY = Math.max(72, contentHeight - orphanRows * 48 - 26);
		placeGrid(positions, orphans, {
			centerX: assistantX,
			startY,
			lane: "assistant",
			width,
			height: contentHeight,
		});
	}

	return { positions, lanes, width, height: contentHeight };
}

function computeLegacyLayout(
	nodes: ReadonlyArray<SessionContextNode>,
	width: number,
	height: number,
): TopologyNodeLayout {
	const top = 56;
	const bottom = 36;
	const rowHeight = 56;
	const padding = 24;
	const byLane = new Map<string, SessionContextNode[]>();
	for (const node of nodes) {
		const lane = byLane.get(node.kind) ?? [];
		lane.push(node);
		byLane.set(node.kind, lane);
	}
	for (const lane of byLane.values()) lane.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
	const laneKinds: string[] = LEGACY_LANE_ORDER.filter((kind) => byLane.has(kind));
	for (const kind of byLane.keys()) if (!laneKinds.includes(kind)) laneKinds.push(kind);
	const laneWidth = Math.max(120, (width - padding * 2) / Math.max(1, laneKinds.length));
	const usableHeight = Math.max(rowHeight, Math.max(...Array.from(byLane.values(), (lane) => lane.length)) * rowHeight);
	const contentHeight = Math.max(height, top + bottom + usableHeight);
	const positions = new Map<string, TopologyNodePosition>();
	const lanes: TopologyNodeLayout["lanes"] = [];
	laneKinds.forEach((kind, laneIndex) => {
		const lane = byLane.get(kind) ?? [];
		const x = clamp(padding + laneIndex * laneWidth + laneWidth / 2, 18, width - 18);
		lanes.push({ kind, x, width: laneWidth });
		const laneStartY = top + (usableHeight - lane.length * rowHeight) / 2;
		lane.forEach((node, nodeIndex) => {
			positions.set(node.id, {
				x,
				y: clamp(laneStartY + (nodeIndex + 0.5) * rowHeight, 18, contentHeight - 18),
				lane: kind,
				depth: 0,
			});
		});
	});
	return { positions, lanes, width, height: contentHeight };
}

function placeChildGrid(
	positions: Map<string, TopologyNodePosition>,
	children: ReadonlyArray<SessionContextNode>,
	opts: { parentNodeId: string; parentX: number; parentY: number; lane: string; width: number; height: number },
): void {
	if (children.length === 0) return;
	const columns = Math.max(1, Math.min(4, children.length));
	const columnGap = Math.min(74, Math.max(48, opts.width * 0.075));
	const rowGap = 48;
	children.forEach((child, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		positions.set(child.id, {
			x: clamp(opts.parentX + (column - (columns - 1) / 2) * columnGap, 18, opts.width - 18),
			y: clamp(opts.parentY + 48 + row * rowGap, 18, opts.height - 18),
			lane: opts.lane,
			depth: 1,
			parentNodeId: opts.parentNodeId,
		});
	});
}

function placeGrid(
	positions: Map<string, TopologyNodePosition>,
	nodes: ReadonlyArray<SessionContextNode>,
	opts: { centerX: number; startY: number; lane: string; width: number; height: number },
): void {
	const columns = Math.max(1, Math.min(4, nodes.length));
	const columnGap = Math.min(74, Math.max(48, opts.width * 0.075));
	nodes.forEach((node, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		positions.set(node.id, {
			x: clamp(opts.centerX + (column - (columns - 1) / 2) * columnGap, 18, opts.width - 18),
			y: clamp(opts.startY + row * 48, 18, opts.height - 18),
			lane: opts.lane,
			depth: 1,
		});
	});
}

function stableNodes(nodes: ReadonlyArray<SessionContextNode>): SessionContextNode[] {
	return [...nodes].sort(compareNodes);
}

function compareNodes(a: SessionContextNode, b: SessionContextNode): number {
	return (a.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER) - (b.sourceTurnIndex ?? Number.MAX_SAFE_INTEGER)
		|| a.createdAt.localeCompare(b.createdAt)
		|| a.id.localeCompare(b.id);
}

function pushSemanticDetail(
	details: TopologyNodeDetail[],
	key: string,
	value: string | undefined,
): void {
	if (value == null || value === "") return;
	details.push({
		key,
		labelKey: `topologyWorkspace.details.${key}`,
		value,
		valueKey: `topologyWorkspace.values.${key}.${value}`,
	});
}

function pushDetail(
	details: TopologyNodeDetail[],
	key: string,
	value: string | number | null | undefined,
): void {
	if (value == null || value === "") return;
	details.push({ key, labelKey: `topologyWorkspace.details.${key}`, value });
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
