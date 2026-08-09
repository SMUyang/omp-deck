import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionContextGraphResponse, SessionContextNode, SessionContextEdge } from "@omp-deck/protocol";

import { cn } from "@/lib/utils";

// ────────────────────────────────────────────────────────────────────
// Pure layout helpers — exported for deterministic testing
// ────────────────────────────────────────────────────────────────────

export interface Point { x: number; y: number; }

/**
 * Compute stable radial node positions in O(n). Nodes are evenly spaced
 * on a circle centered in the viewport, starting at the top (−π/2).
 * Deterministic: same input always produces identical coordinates.
 */
export function computeNodePositions(
	nodes: ReadonlyArray<{ id: string }>,
	width: number,
	height: number,
): Map<string, Point> {
	const centerX = width / 2;
	const centerY = height / 2;
	const radius = Math.min(width, height) * 0.36;
	const n = nodes.length;
	const positions = new Map<string, Point>();

	for (let i = 0; i < n; i++) {
		const angle = (Math.PI * 2 * i) / n - Math.PI / 2; // start at top
		positions.set(nodes[i]!.id, {
			x: centerX + Math.cos(angle) * radius,
			y: centerY + Math.sin(angle) * radius,
		});
	}

	return positions;
}

/**
 * Compute per-node degree from edge connections. Degree = inbound + outbound.
 * Nodes with no edges get degree 0. Edges pointing to non-existent nodes
 * are counted (the source still contributes).
 */
export function computeNodeDegree(
	nodes: ReadonlyArray<{ id: string }>,
	edges: ReadonlyArray<{ sourceNodeId: string; targetNodeId: string }>,
): Map<string, number> {
	const degree = new Map<string, number>();
	for (const node of nodes) degree.set(node.id, 0);
	for (const edge of edges) {
		degree.set(edge.sourceNodeId, (degree.get(edge.sourceNodeId) ?? 0) + 1);
		degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) ?? 0) + 1);
	}
	return degree;
}

/** Compute node radius from degree, matching the MemoryGraphSvg formula. */
export function computeNodeRadius(degree: number): number {
	return 7 + Math.min(10, Math.sqrt(degree + 1) * 2);
}

/** Kind → SVG class mapping. Plan colors: goal=accent, decision=thinking, action=success, issue=danger, artifact=ink-3. */
export const KIND_COLORS: Record<string, { fill: string; stroke: string }> = {
	goal:          { fill: "fill-accent/30",   stroke: "stroke-accent" },
	decision:      { fill: "fill-thinking/30",  stroke: "stroke-thinking" },
	action:        { fill: "fill-success/30",   stroke: "stroke-success" },
	issue:         { fill: "fill-danger/30",    stroke: "stroke-danger" },
	artifact:      { fill: "fill-ink-3/30",     stroke: "stroke-ink-3" },
	user_intent:   { fill: "fill-accent-soft/30", stroke: "stroke-accent-soft" },
	constraint:    { fill: "fill-warn/30",       stroke: "stroke-warn" },
	resolution:    { fill: "fill-success/30",    stroke: "stroke-success" },
	evidence:      { fill: "fill-ink-3/30",      stroke: "stroke-ink-3" },
	todo_state:    { fill: "fill-ink-4/30",      stroke: "stroke-ink-4" },
	handoff_summary: { fill: "fill-accent-soft/30", stroke: "stroke-accent-soft" },
};

/** Fallback colors for unknown node kinds. */
const DEFAULT_KIND_COLORS = { fill: "fill-ink-4/30", stroke: "stroke-ink-4" };

// ────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────

const SVG_WIDTH = 760;
const SVG_HEIGHT = 320;

export interface SessionContextTopologyGraphProps {
	graph: SessionContextGraphResponse | null;
	loading: boolean;
	error?: string;
	selectedNodeId: string | null;
	onSelectNode: (nodeId: string | null) => void;
	className?: string;
}

export function SessionContextTopologyGraph({
	graph,
	loading,
	error,
	selectedNodeId,
	onSelectNode,
	className,
}: SessionContextTopologyGraphProps) {
	const { t } = useTranslation();
	// Memoise layout — only recomputes when graph nodes change.
	const positions = useMemo(
		() => (graph ? computeNodePositions(graph.nodes, SVG_WIDTH, SVG_HEIGHT) : new Map<string, Point>()),
		[graph?.nodes],
	);

	const degreeMap = useMemo(
		() => (graph ? computeNodeDegree(graph.nodes, graph.edges) : new Map<string, number>()),
		[graph?.nodes, graph?.edges],
	);

	const handleKeyDown = useCallback(
		(nodeId: string) => (event: React.KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			onSelectNode(selectedNodeId === nodeId ? null : nodeId);
		},
		[onSelectNode, selectedNodeId],
	);

	// ── Loading state ──
	if (loading) {
		return (
			<div
				className={cn("flex h-[300px] w-full items-center justify-center rounded-md border border-line bg-paper text-sm text-ink-3", className)}
				role="status"
				aria-label={t("settings.sessionTopologyGraph.loadingAria")}
			>
				{t("settings.sessionTopologyGraph.loading")}
			</div>
		);
	}

	// ── Error state ──
	if (error) {
		return (
			<div
				className={cn("flex h-[300px] w-full items-center justify-center rounded-md border border-danger/30 bg-paper text-sm text-danger", className)}
				role="alert"
				aria-label={t("settings.sessionTopologyGraph.errorAria", { error })}
			>
				{error}
			</div>
		);
	}

	// ── Empty state ──
	if (!graph || graph.nodes.length === 0) {
		return (
			<div
				className={cn("flex h-[300px] w-full items-center justify-center rounded-md border border-line bg-paper text-sm text-ink-3", className)}
				role="status"
				aria-label={t("settings.sessionTopologyGraph.emptyAria")}
			>
				{t("settings.sessionTopologyGraph.empty")}
			</div>
		);
	}

	// ── Normal graph ──
	const selectedNode = selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) ?? null : null;

	return (
		<div className={cn("space-y-2", className)}>
			{/* Graph stats and truncation warning */}
			<div className="flex items-center justify-between px-1 text-[11px] text-ink-3">
				<span>
					{t("settings.sessionTopologyGraph.stats", { nodes: graph.nodes.length, edges: graph.edges.length })}
				</span>
				{graph.truncated && (
					<span className="text-warn">
						{t("settings.sessionTopologyGraph.partialGraph", { total: graph.totalNodes })}
					</span>
				)}
			</div>

			<svg
				viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
				role="img"
				aria-label={t("settings.sessionTopologyGraph.graphAria")}
				className="h-[300px] w-full overflow-visible rounded-md border border-line bg-paper"
			>
				{/* ── Edges: uniform lines, labeled by relation ── */}
				{graph.edges.map((edge, index) => {
					const source = positions.get(edge.sourceNodeId);
					const target = positions.get(edge.targetNodeId);
					if (!source || !target) return null;
					const midX = (source.x + target.x) / 2;
					const midY = (source.y + target.y) / 2;
					return (
						<g key={`${edge.id ?? `${edge.sourceNodeId}:${edge.targetNodeId}:${index}`}`}>
							<title>{edge.relation}</title>
							<line
								x1={source.x} y1={source.y}
								x2={target.x} y2={target.y}
								className="stroke-accent/25"
								strokeWidth={1.2}
							/>
							<text
								x={midX} y={midY - 3}
								textAnchor="middle"
								className="fill-accent/60 font-mono text-[7px]"
							>
								{edge.relation}
							</text>
						</g>
					);
				})}

				{/* ── Nodes: colored by kind, sized by degree ── */}
				{graph.nodes.map((node) => {
					const position = positions.get(node.id);
					if (!position) return null;
					const degree = degreeMap.get(node.id) ?? 0;
					const selected = selectedNodeId === node.id;
					const colors = KIND_COLORS[node.kind] ?? DEFAULT_KIND_COLORS;
					const r = computeNodeRadius(degree);
					const selectedStroke = selected ? "stroke-accent" : colors.stroke.replace("stroke-", "stroke-");
					return (
						<g
							key={node.id}
							role="button"
							tabIndex={0}
							onClick={() => onSelectNode(selected ? null : node.id)}
							onKeyDown={handleKeyDown(node.id)}
							className="cursor-pointer outline-none"
							aria-label={`${node.kind}: ${node.title}${selected ? t("settings.sessionTopologyGraph.selected") : ""}`}
						>
							<title>{`${node.kind}: ${node.title}`}</title>
							<circle
								cx={position.x} cy={position.y} r={r}
								className={selected ? "fill-accent/30 stroke-accent" : `${colors.fill} ${colors.stroke}`}
								strokeWidth={selected ? 2.5 : 1.4}
							/>
							<text
								x={position.x} y={position.y + r + 10}
								textAnchor="middle"
								className="fill-ink-3 font-mono text-[7px]"
							>
								{node.title.length > 12 ? node.title.slice(0, 11) + "…" : node.title}
							</text>
						</g>
					);
				})}
			</svg>

			{/* ── Legend: node kind colors ── */}
			<div className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[10px] text-ink-3">
				{(["goal", "decision", "action", "issue", "artifact"] as const).map((kind) => {
					const colors = KIND_COLORS[kind]!;
					return (
						<span key={kind} className="inline-flex items-center gap-1">
							<span
								className={cn("inline-block h-2 w-2 rounded-full", colors.fill)}
								aria-hidden="true"
							/>
							{t(`settings.sessionTopologyGraph.kinds.${kind}`)}
						</span>
					);
				})}
			</div>

			{/* ── Selected node detail ── */}
			{selectedNode && (
				<div className="rounded-md border border-accent/30 bg-paper-2 p-2 text-xs" aria-label={t("settings.sessionTopologyGraph.selectedNodeAria")}>
					<div className="flex items-center gap-1.5 text-ink-2">
						<span
							className={cn(
								"inline-block h-2 w-2 rounded-full",
								KIND_COLORS[selectedNode.kind]?.fill ?? DEFAULT_KIND_COLORS.fill,
							)}
							aria-hidden="true"
						/>
						<strong className="text-ink">{selectedNode.title}</strong>
						<span className="text-ink-4">· {selectedNode.kind}</span>
					</div>
					{selectedNode.compressedBody && (
						<p className="mt-1 text-ink-3">{selectedNode.compressedBody}</p>
					)}
					{selectedNode.sourceTurnIndex != null && (
						<span className="mt-1 block text-ink-4">{t("settings.sessionTopologyGraph.turn", { index: selectedNode.sourceTurnIndex })}</span>
					)}
				</div>
			)}
		</div>
	);
}
