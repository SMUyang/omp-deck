/**
 * TopologyGraph — a layered, "graphical" rendering of the session
 * context graph that doubles as the focal-area preview.
 *
 * Visual contract:
 *   - **Two color axes.** Kind drives the fill (via `getNodeKindTone`),
 *     a "in focus" boolean drives the outer ring stroke — focus members
 *     get a thicker accent ring so the user can see, at a glance, exactly
 *     which nodes the next model turn will receive in
 *     `<session_topology_subgraph>`.
 *   - **Importance = radius.** Node radius scales with `importance`
 *     (square root, 8→18px), so heavy-hitter facts visually pop.
 *   - **Layered layout.** Nodes are bucketed by their kind into vertical
 *     lanes (goal/decision/issue/resolution/evidence …). Inside a lane,
 *     y is allocated evenly. Edges curve between lanes; the control
 *     points keep them visually separable from straight diagonals when
 *     many edges cross the canvas.
 *   - **Edge semantics.** Stroke-dasharray by relation — solid for
 *     "constructive" relations, dashed for "blocking/contradiction",
 *     dotted for "summary/supersedes". Weight controls stroke-width.
 *   - **Hover/select.** Hover surfaces a tooltip; click toggles
 *     selection. Selecting a node also lights its 1-hop neighbors.
 */

import { useCallback, useMemo, useState } from "react";
import type { SessionContextEdge, SessionContextGraphResponse, SessionContextNode } from "@omp-deck/protocol";
import { cn } from "@/lib/utils";
import { getNodeKindTone } from "@/lib/node-kind-tones";

const MIN_RADIUS = 8;
const MAX_RADIUS = 18;

const LANE_ORDER = [
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

const EDGE_STROKE: Record<string, { dash: string; color: string }> = {
	caused_by:        { dash: "0",        color: "stroke-accent/40" },
	fixed_by:         { dash: "0",        color: "stroke-success/50" },
	verified_by:      { dash: "0",        color: "stroke-success/40" },
	depends_on:       { dash: "0",        color: "stroke-ink-3/45" },
	continues:        { dash: "0",        color: "stroke-accent-soft/50" },
	references_file:  { dash: "0",        color: "stroke-ink-3/30" },
	blocks:           { dash: "4 3",      color: "stroke-danger/55" },
	contradicts:      { dash: "4 3",      color: "stroke-danger/55" },
	supersedes:       { dash: "1 3",      color: "stroke-thinking/55" },
	summarizes:       { dash: "1 3",      color: "stroke-thinking/55" },
};

function MiniKindSummary({ graph, focusIds }: { graph: SessionContextGraphResponse; focusIds: Set<string> }) {
	const counts = new Map<string, { total: number; focus: number }>();
	for (const node of graph.nodes) {
		const c = counts.get(node.kind) ?? { total: 0, focus: 0 };
		c.total += 1;
		if (focusIds.has(node.id)) c.focus += 1;
		counts.set(node.kind, c);
	}
	const kinds = Array.from(counts.entries()).sort((a, b) => b[1].total - a[1].total);
	return (
		<div className="space-y-0.5 px-1 pb-1">
			{kinds.map(([kind, c]) => {
				const tone = getNodeKindTone(kind);
				const widthPct = Math.max(2, Math.round((c.total / graph.nodes.length) * 100));
				return (
					<div key={kind} className="flex items-center gap-2 text-[10px]">
						<span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
						<span className="w-20 shrink-0 font-mono uppercase tracking-meta text-ink-3">{tone.label}</span>
						<span className="relative h-1.5 flex-1 rounded-full bg-paper-3">
							<span className={cn("absolute inset-y-0 left-0 rounded-full", tone.dot)} style={{ width: widthPct + "%" }} />
							{c.focus > 0 ? (
								<span className="absolute inset-0 ring-1 ring-inset ring-accent/70 rounded-full" aria-label={`${c.focus} in focus`} />
							) : null}
						</span>
						<span className="w-12 shrink-0 text-right font-mono text-ink-2">{c.focus}/{c.total}</span>
					</div>
				);
			})}
		</div>
	);
}
export interface TopologyGraphProps {
	graph: SessionContextGraphResponse | null;
	/** Node ids that the next model turn will receive (focus set). */
	focusIds?: ReadonlySet<string>;
	loading?: boolean;
	error?: string;
	selectedNodeId?: string | null;
	onSelectNode?: (nodeId: string | null) => void;
	className?: string;
	/** Compact sizing for the inspector mini graph; default is full-width. */
	variant?: "full" | "mini";
	/** When true, render only the focus subgraph + 1-hop neighbors. */
	focusOnly?: boolean;
}

export function TopologyGraph({
	graph,
	focusIds,
	loading,
	error,
	selectedNodeId = null,
	onSelectNode,
	className,
	variant = "full",
	focusOnly = false,
}: TopologyGraphProps) {
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const focusSet = useMemo<Set<string>>(() => new Set(focusIds ?? []), [focusIds]);

	// Every hook above this line — Rules of Hooks.

	const visibleGraph = useMemo<SessionContextGraphResponse | null>(() => {
		if (!graph) return null;
		if (!focusOnly || focusSet.size === 0) return graph;
		const keep = new Set<string>(focusSet);
		for (const edge of graph.edges) {
			if (focusSet.has(edge.sourceNodeId)) keep.add(edge.targetNodeId);
			if (focusSet.has(edge.targetNodeId)) keep.add(edge.sourceNodeId);
		}
		const nodes = graph.nodes.filter((n) => keep.has(n.id));
		const edges = graph.edges.filter((e) => keep.has(e.sourceNodeId) && keep.has(e.targetNodeId));
		return { ...graph, nodes, edges };
	}, [graph, focusSet, focusOnly]);

	const layout = useMemo(() => {
		if (!visibleGraph) return null;
		return layoutLanes(visibleGraph.nodes, visibleGraph.edges, { mini: variant === "mini" });
	}, [visibleGraph, variant]);

	const handleSelect = useCallback(
		(nodeId: string | null) => {
			onSelectNode?.(selectedNodeId === nodeId ? null : nodeId);
		},
		[onSelectNode, selectedNodeId],
	);

	const active = hoveredId ?? selectedNodeId;
	const neighbors = useMemo<Set<string>>(() => {
		if (!active) return new Set<string>();
		const out = new Set<string>();
		for (const e of visibleGraph?.edges ?? []) {
			if (e.sourceNodeId === active) out.add(e.targetNodeId);
			if (e.targetNodeId === active) out.add(e.sourceNodeId);
		}
		return out;
	}, [active, visibleGraph]);

	// Pre-compute node counts used by both the full render and the mini
	// degradation branch (which returns before these are otherwise declared).
	const focusCount = visibleGraph ? visibleGraph.nodes.filter((n) => focusSet.has(n.id)).length : 0;
	const visibleCount = visibleGraph?.nodes.length ?? 0;

	if (loading) {
		return <State className={cn("border-line text-ink-3", className)}>Loading graph…</State>;
	}
	if (error) {
		return <State className={cn("border-danger/30 text-danger", className)}>{error}</State>;
	}
	if (!visibleGraph || visibleGraph.nodes.length === 0) {
		return <State className={cn("border-line text-ink-3", className)}>No nodes in this session context.</State>;
	}

	if (variant === "mini" && visibleCount > 24) {
		return (
			<div className={cn("space-y-1", className)}>
				<header className="flex items-center justify-between px-1 text-[11px] text-ink-3">
					<span>{visibleCount} nodes · {focusCount} in focus</span>
					<a href="/topology" className="text-accent hover:underline">open full topology →</a>
				</header>
				<MiniKindSummary graph={visibleGraph} focusIds={focusSet} />
			</div>
		);
	}

	const selectedNode = selectedNodeId ? visibleGraph.nodes.find((n) => n.id === selectedNodeId) ?? null : null;
// (focusCount computed above for the mini-degradation branch.)
	const layoutHeight = layout ? layout.height : 220;
	const height = variant === "mini" ? 220 : layoutHeight;
	const width = layout?.width ?? 800;

	return (
		<div className={cn("space-y-2", className)}>
			<header className="flex items-center justify-between px-1 text-[11px] text-ink-3">
				<span>
					{visibleGraph.nodes.length} nodes · {visibleGraph.edges.length} edges
					{focusSet.size > 0 ? (
						<>
							{" · "}
							<span className="text-accent">{focusCount} in focus</span>
						</>
					) : null}
				</span>
				{visibleGraph.truncated ? (
					<span className="text-warn">Showing partial graph of {visibleGraph.totalNodes}</span>
				) : null}
			</header>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label="Session context topology graph"
				className={cn(
					"w-full overflow-hidden rounded-md border border-line bg-paper",
					variant === "mini" ? "h-[220px]" : `h-[${height}px]`,
				)}
			>
				{/* Lane separators */}
				{layout?.lanes.slice(0, -1).map((lane) => (
					<line
						key={`sep-${lane.kind}`}
						x1={lane.x + lane.width / 2 + 32}
						y1={28}
						x2={lane.x + lane.width / 2 + 32}
						y2={height - 24}
						className="stroke-line/60"
						strokeDasharray="2 6"
					/>
				))}

				{/* Edges */}
				{visibleGraph.edges.map((edge, i) => {
					const a = layout?.positions.get(edge.sourceNodeId);
					const b = layout?.positions.get(edge.targetNodeId);
					if (!a || !b) return null;
					const dimmed = active && !(active === edge.sourceNodeId || active === edge.targetNodeId);
					const focusEdge = focusSet.has(edge.sourceNodeId) && focusSet.has(edge.targetNodeId);
					const stroke = EDGE_STROKE[edge.relation] ?? { dash: "0", color: "stroke-ink-3/30" };
					return (
						<g
							key={`${edge.id ?? `${edge.sourceNodeId}:${edge.targetNodeId}:${i}`}`}
							opacity={dimmed ? 0.18 : 1}
						>
							<title>{`${edge.relation}${focusEdge ? " · in focus" : ""}`}</title>
							<path
								d={quadraticPath(a, b)}
								fill="none"
								className={cn(stroke.color, focusEdge && "opacity-100")}
								strokeWidth={0.8 + Math.min(2.4, edge.weight * 2.4)}
								strokeDasharray={stroke.dash}
							/>
						</g>
					);
				})}

				{/* Nodes */}
				{visibleGraph.nodes.map((node) => {
					const p = layout?.positions.get(node.id);
					if (!p) return null;
					const tone = getNodeKindTone(node.kind);
					const r = radiusFor(node.importance);
					const isFocus = focusSet.has(node.id);
					const isActive = active === node.id;
					const isNeighbor = neighbors.has(node.id);
					const faded = active && !isActive && !isNeighbor;
					return (
						<g
							key={node.id}
							role="button"
							tabIndex={0}
							opacity={faded ? 0.25 : 1}
							onClick={() => handleSelect(node.id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									handleSelect(node.id);
								}
							}}
							onMouseEnter={() => setHoveredId(node.id)}
							onMouseLeave={() => setHoveredId((cur) => (cur === node.id ? null : cur))}
							className="cursor-pointer outline-none"
							aria-label={`${node.kind}: ${node.title}${isFocus ? " · in focus" : ""}`}
						>
							<title>{`${node.kind} · importance ${node.importance.toFixed(2)}\n${node.title}\n${isFocus ? "(will be sent to the model)" : ""}`}</title>
							{/* Focus halo: drawn behind the disc so the fill color stays intact. */}
							{isFocus ? (
								<circle cx={p.x} cy={p.y} r={r + 5} className="fill-accent-soft/40" />
							) : null}
							<circle
								cx={p.x} cy={p.y} r={r}
								className={cn(tone.dot, isActive ? "opacity-100" : "opacity-85")}
							/>
							<circle
								cx={p.x} cy={p.y} r={r}
								fill="none"
								strokeWidth={isFocus ? 2.4 : 1.4}
								className={cn(
									isActive
										? "stroke-ink"
										: isFocus
											? "stroke-accent"
											: "stroke-ink-3/50",
								)}
							/>
							{variant === "full" ? (
								<text
									x={p.x} y={Math.max(12, p.y - r - 5)}
									textAnchor="middle"
									className="fill-ink-3 font-mono text-[9px]"
									>
									{node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title}
								</text>
							) : null}
						</g>
					);
				})}
			</svg>
			{variant === "full" ? <Legend /> : null}
			{selectedNode ? <Detail node={selectedNode} focus={focusSet.has(selectedNode.id)} /> : null}
		</div>
	);
}

// ─── Layout ────────────────────────────────────────────────────────────────

interface LaneLayout {
	kind: string;
	x: number;
	width: number;
}

interface LayoutResult {
	positions: Map<string, { x: number; y: number }>;
	lanes: LaneLayout[];
	width: number;
	height: number;
}

function layoutLanes(
	nodes: ReadonlyArray<SessionContextNode>,
	edges: ReadonlyArray<SessionContextEdge>,
	opts: { mini: boolean },
): LayoutResult {
	const top = opts.mini ? 22 : 56;
	const bottom = opts.mini ? 22 : 36;
	const rowHeight = opts.mini ? 32 : 56;
	const laneWidth = opts.mini ? 130 : 160;
	const padding = 24;

	const byLane = new Map<string, SessionContextNode[]>();
	for (const node of nodes) {
		const arr = byLane.get(node.kind) ?? [];
		arr.push(node);
		byLane.set(node.kind, arr);
	}
	for (const arr of byLane.values()) {
		arr.sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
	}

	const laneKinds = LANE_ORDER.filter((k) => byLane.has(k));
	for (const k of byLane.keys()) {
		if (!laneKinds.includes(k as (typeof LANE_ORDER)[number])) laneKinds.push(k as (typeof LANE_ORDER)[number]);
	}

	const width = Math.max(opts.mini ? 480 : 700, padding * 2 + laneKinds.length * laneWidth);
	const usableHeight = Math.max(rowHeight, Math.max(...Array.from(byLane.values(), (arr) => arr.length)) * rowHeight);
	const height = top + bottom + usableHeight;

	const positions = new Map<string, { x: number; y: number }>();
	const lanes: LaneLayout[] = [];
	laneKinds.forEach((kind, i) => {
		const arr = byLane.get(kind) ?? [];
		const x = padding + i * laneWidth + laneWidth / 2;
		lanes.push({ kind, x, width: laneWidth });
		const laneStartY = top + (usableHeight - arr.length * rowHeight) / 2;
		arr.forEach((node, j) => {
			const y = laneStartY + (j + 0.5) * rowHeight;
			positions.set(node.id, { x, y });
		});
	});

	return { positions, lanes, width: Math.max(width, padding * 2 + lanes.length * laneWidth), height };
}

function radiusFor(importance: number): number {
	const clamped = Math.max(0, Math.min(1, importance));
	return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(clamped);
}

function quadraticPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
	const dx = b.x - a.x;
	const cx = (a.x + b.x) / 2 + (a.y > b.y ? -Math.min(40, Math.abs(dx) * 0.2) : Math.min(40, Math.abs(dx) * 0.2));
	const cy = (a.y + b.y) / 2;
	return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

// ─── Pieces ────────────────────────────────────────────────────────────────

function State({ className, children }: { className?: string; children: React.ReactNode }) {
	return (
		<div
			role="status"
			className={cn(
				"flex h-[220px] w-full items-center justify-center rounded-md border bg-paper text-xs",
				className,
			)}
		>
			{children}
		</div>
	);
}

function Legend() {
	const items: ReadonlyArray<string> = ["goal", "decision", "action", "resolution", "issue", "evidence"];
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[10px] text-ink-3">
			{items.map((kind) => {
				const tone = getNodeKindTone(kind);
				return (
					<span key={kind} className="inline-flex items-center gap-1">
						<span className={cn("inline-block h-2 w-2 rounded-full", tone.dot)} aria-hidden="true" />
						{kind}
					</span>
				);
			})}
			<span className="inline-flex items-center gap-1">
				<span className="inline-block h-2 w-2 rounded-full border-2 border-accent" aria-hidden="true" />
				in focus
			</span>
		</div>
	);
}

function Detail({ node, focus }: { node: SessionContextNode; focus: boolean }) {
	const tone = getNodeKindTone(node.kind);
	return (
		<div
			className={cn(
				"rounded-md border bg-paper-2 p-2 text-xs",
				focus ? "border-accent/40" : "border-line",
			)}
		>
			<div className="flex items-center gap-1.5 text-ink-2">
				<span className={cn("inline-block h-2 w-2 rounded-full", tone.dot)} aria-hidden="true" />
				<strong className="text-ink">{node.title}</strong>
				<span className="text-ink-4">· {node.kind}</span>
				{focus ? (
					<span className="ml-auto rounded border border-accent/40 px-1 py-0.5 font-mono text-[10px] uppercase tracking-meta text-accent">
						in focus
					</span>
				) : null}
			</div>
			{node.compressedBody ? <p className="mt-1 text-ink-3">{node.compressedBody}</p> : null}
			<div className="mt-1 flex items-center gap-3 text-ink-4">
				<span>importance {node.importance.toFixed(2)}</span>
				{node.sourceTurnIndex != null ? <span>turn {node.sourceTurnIndex + 1}</span> : null}
			</div>
		</div>
	);



}
