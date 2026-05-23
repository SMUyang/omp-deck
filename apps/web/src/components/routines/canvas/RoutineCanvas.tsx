/**
 * V2 canvas-mode editor for a routine.
 *
 * - P1.2: empty React Flow surface, deck-themed.
 * - P1.3: graph import — render the routine's `steps` as nodes, with explicit
 *   `layout.edges` when present and inferred sequential + dependency edges
 *   when not.
 * - P1.4: drag-position persistence. Dragging a node updates the parent spec's
 *   `layout.nodes` on drag-end; the layout block round-trips through
 *   `stringifySpec` so reopening the routine restores positions.
 * - T-64 (P2.1): floating "Add step" palette pinned top-left of the viewport.
 *   Replaces the prior horizontal-scroll toolbar with a categorized popover.
 * - T-65 (P2.2 — this build): click-to-inspect slide-over. Selecting a node
 *   opens a right-edge panel that reuses the existing `StepCommonFields` +
 *   per-type form components. Esc / X / Delete all close it; rename cascades
 *   through `layout.nodes` + `layout.edges` via `replaceStep`.
 * - P3 adds edge creation + branching; P4 paints run-status overlays.
 *
 * Theming approach: React Flow ships with light-mode CSS that uses CSS custom
 * properties (`--xy-background-color`, `--xy-edge-stroke`, etc). We import its
 * stylesheet once globally and override the variables on the `.routine-canvas`
 * wrapper so the canvas inherits whichever deck theme is active.
 */

import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	ReactFlow,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
	useReactFlow,
	type Connection,
	type EdgeChange,
	type NodeChange,
	type NodePositionChange,
	type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
	RoutineDeckAction,
	RoutineLayout,
	RoutineRun,
	RoutineSpec,
	RoutineStep,
	RoutineStepRun,
} from "@omp-deck/protocol";

import { removeStep, replaceStep, scaffoldStep } from "../spec-yaml";

import { AddStepPalette } from "./AddStepPalette";
import { SequentialEdge } from "./edges/SequentialEdge";
import { applyAddNodeAtBottom } from "./graph-add";
import type { CompileError } from "./graph-compile";
import { applyEdgeConnection, applyEdgeRemoval } from "./graph-connect";
import { importFromSpec } from "./graph-import";
import type {
	SequentialEdge as SequentialEdgeType,
	StepNode as StepNodeType,
} from "./graph-types";
import { StepNode } from "./nodes/StepNode";
import { StepInspector } from "./StepInspector";

interface RoutineCanvasProps {
	/** The routine spec being edited. */
	spec: RoutineSpec;
	/** Called whenever the canvas commits a change to the spec. */
	onChange: (next: RoutineSpec) => void;
	/**
	 * Compile errors from the parent's `compileGraph(spec)` memo. The canvas
	 * overlays a red ring on offending nodes and renders the message strip;
	 * the parent gates the Save button on this list being empty.
	 */
	compileErrors?: ReadonlyArray<CompileError>;
	/**
	 * T-71: per-step run record for the currently-displayed run. The canvas
	 * stamps `stepRun` onto each node's `data.stepRun` so StepNode renders
	 * the status ring + telemetry badges. Empty/absent for routines that
	 * haven't run yet.
	 */
	stepRunsByStepId?: ReadonlyMap<string, RoutineStepRun>;
	/**
	 * T-71: recent runs for the last-run picker. Rendered in the canvas
	 * toolbar when >= 2 runs exist so the author can scrub through history.
	 */
	runs?: ReadonlyArray<RoutineRun>;
	/** Currently-selected run id; mirror of the picker's value. */
	selectedRunId?: string | null;
	/** Picker change handler. */
	onSelectRun?: (runId: string | null) => void;
	/**
	 * T-72: optional deep-link target for the "Open in Run Detail" button on
	 * the inspector's last-run section. Receives `{ routineId, runId, stepId }`
	 * resolved from the selected node + selected run.
	 */
	routineId?: string;
}

const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { sequential: SequentialEdge };

const WIDE_VIEWPORT_QUERY = "(min-width: 1100px)";

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() => typeof window !== "undefined" && window.matchMedia(query).matches,
	);
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mql = window.matchMedia(query);
		const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

// T-77: keep fitView from zooming out below a legible scale on tall, narrow
// graphs (linear pipelines stack vertically and the canvas is wider than the
// graph). User can scroll vertically if the graph overflows the viewport;
// they cannot read 80x30px nodes regardless of how much horizontal space we
// "save".
const FIT_VIEW_OPTIONS = { padding: 0.2, minZoom: 0.7, maxZoom: 1.5 } as const;

export function RoutineCanvas(props: RoutineCanvasProps): JSX.Element {
	return (
		<ReactFlowProvider>
			<RoutineCanvasInner {...props} />
		</ReactFlowProvider>
	);
}

function RoutineCanvasInner({
	spec,
	onChange,
	compileErrors,
	stepRunsByStepId,
	runs,
	selectedRunId,
	onSelectRun,
	routineId,
}: RoutineCanvasProps): JSX.Element {
	// Re-derive the React Flow graph whenever the spec's steps or layout change.
	const imported = useMemo(
		() => importFromSpec(spec),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[spec.steps, spec.layout],
	);

	// Flatten compile errors into a `step id -> first message` map. The ring
	// color is the same for every error kind, so picking the first message per
	// node keeps the node-level tooltip + inline badge short and stable.
	const errorByStepId = useMemo(() => {
		const m = new Map<string, string>();
		for (const err of compileErrors ?? []) {
			for (const id of err.nodeIds) {
				if (!m.has(id)) m.set(id, err.message);
			}
		}
		return m;
	}, [compileErrors]);

	// Canvas-local "if-flavored" tracker. The `if` palette entry scaffolds a
	// transform step; the node renders with two labeled handles when EITHER
	// (a) it has at least one outgoing branch edge already, OR (b) the user
	// just added it via the palette and hasn't wired anything yet. The set
	// covers (b); (a) is derived from `spec.layout.edges` at render time.
	// Persists across saves via the edge kinds; local ids decay automatically
	// when the step is removed from the spec.
	const [ifNodeIds, setIfNodeIds] = useState<ReadonlySet<string>>(() => new Set());
	const ifNodeIdsRef = useRef(ifNodeIds);
	useEffect(() => {
		ifNodeIdsRef.current = ifNodeIds;
	}, [ifNodeIds]);

	// Prune locally-flagged ids that no longer exist in the spec (e.g. node
	// deleted from the inspector). Cheap: only allocates when the set changes.
	useEffect(() => {
		if (ifNodeIds.size === 0) return;
		const validIds = new Set(spec.steps.map((s) => s.id));
		let mutated = false;
		const next = new Set<string>();
		for (const id of ifNodeIds) {
			if (validIds.has(id)) next.add(id);
			else mutated = true;
		}
		if (mutated) setIfNodeIds(next);
	}, [spec.steps, ifNodeIds]);

	// A node is "if-flavored" iff (a) it carries at least one outgoing branch
	// edge in the persisted layout, or (b) the local tracker remembers it.
	const isIfNode = useMemo(() => {
		const fromEdges = new Set<string>();
		for (const e of spec.layout?.edges ?? []) {
			if (e.kind === "true" || e.kind === "false") fromEdges.add(e.from);
		}
		return (id: string): boolean => fromEdges.has(id) || ifNodeIds.has(id);
	}, [spec.layout?.edges, ifNodeIds]);

	const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeType>(imported.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState<SequentialEdgeType>(imported.edges);
	const rf = useReactFlow();

	// Canvas-owned selection state. React Flow's internal node.selected flag
	// is the rendering source of truth; this is the AUTHORITATIVE id we use
	// to look up the selected step in `spec.steps` for the inspector.
	const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

	// Pin the latest spec + selection so callbacks read the freshest values
	// without re-binding (which would churn handlers on every keystroke).
	const specRef = useRef(spec);
	useEffect(() => {
		specRef.current = spec;
	}, [spec]);
	const selectedStepIdRef = useRef(selectedStepId);
	useEffect(() => {
		selectedStepIdRef.current = selectedStepId;
	}, [selectedStepId]);

	// On spec change, compile-error change, if-flag change, or run-overlay
	// change: reapply selection AND stamp `compileError`, `isIfNode`, `stepRun`
	// onto each node's data. Routes selection state through React Flow's
	// `selected` flag; everything else flows through `data.*` to the StepNode
	// renderer.
	useEffect(() => {
		const selId = selectedStepIdRef.current;
		setNodes(
			imported.nodes.map((n) => {
				const err = errorByStepId.get(n.id);
				const ifFlag = isIfNode(n.id);
				const run = stepRunsByStepId?.get(n.id);
				const sameErr = err === n.data.compileError;
				const sameIf = ifFlag === (n.data.isIfNode ?? false);
				const sameRun = run === n.data.stepRun;
				const data = sameErr && sameIf && sameRun
					? n.data
					: { ...n.data, compileError: err, isIfNode: ifFlag, stepRun: run };
				const selected = selId === n.id;
				if (data === n.data && !selected) return n;
				return selected ? { ...n, data, selected: true } : { ...n, data };
			}),
		);
		setEdges(imported.edges);
	}, [imported, errorByStepId, isIfNode, stepRunsByStepId, setNodes, setEdges]);

	const handleNodesChange = useCallback(
		(changes: NodeChange<StepNodeType>[]) => {
			onNodesChange(changes);
			const committed = changes.filter(
				(c): c is NodePositionChange =>
					c.type === "position" && c.dragging === false && !!c.position,
			);
			if (committed.length === 0) return;
			// Apply committed positions to the most-recent spec and propagate up.
			const currentSpec = specRef.current;
			const next = applyPositionCommits(currentSpec, committed);
			if (next !== currentSpec) onChange(next);
		},
		[onNodesChange, onChange],
	);

	// T-66: edge authoring. Connect = add explicit edge to `layout.edges`,
	// lifting inferred sequentials on first author so the visual graph
	// doesn't collapse. Edge removal mirrors back to `layout.edges` so a
	// user-deleted edge persists across saves. Inferred edges are
	// `deletable: false` in graph-import — if a remove change for one
	// somehow slips through, the spec lookup short-circuits as a no-op.
	//
	// T-68: if a connection originated from a labeled handle (`true` /
	// `false`), persist the edge kind so T-69's branch compilation picks it
	// up. Connections from the default handle keep `success` semantics.
	const handleConnect = useCallback(
		(conn: Connection) => {
			const { source, target, sourceHandle } = conn;
			if (!source || !target) return;
			const currentSpec = specRef.current;
			const kind =
				sourceHandle === "true" || sourceHandle === "false"
					? sourceHandle
					: undefined;
			const next = applyEdgeConnection(currentSpec, source, target, kind);
			if (next !== currentSpec) onChange(next);
		},
		[onChange],
	);

	const handleEdgesChange = useCallback(
		(changes: EdgeChange<SequentialEdgeType>[]) => {
			onEdgesChange(changes);
			const removals = changes.filter((c) => c.type === "remove");
			if (removals.length === 0) return;
			// Map each removed React Flow edge id back to its source/target/kind
			// via the latest known edges array, then apply to spec one at a time.
			let nextSpec = specRef.current;
			for (const change of removals) {
				const edge = edges.find((e) => e.id === change.id);
				if (!edge) continue;
				const kind = edge.data?.kind ?? "success";
				nextSpec = applyEdgeRemoval(nextSpec, edge.source, edge.target, kind);
			}
			if (nextSpec !== specRef.current) onChange(nextSpec);
		},
		[onEdgesChange, edges, onChange],
	);

	// Keep canvas-local selection in lockstep with React Flow's view of
	// what's selected. Exactly one selected node → inspector opens; zero or
	// many → inspector closes.
	const handleSelectionChange = useCallback(
		(params: OnSelectionChangeParams) => {
			const ids = params.nodes
				.map((n) => (n.type === "step" ? n.id : undefined))
				.filter((id): id is string => typeof id === "string");
			setSelectedStepId(ids.length === 1 ? ids[0]! : null);
		},
		[],
	);

	// T-64: palette → scaffold + insert + stamp a bottom-anchored layout
	// position. T-65: also auto-select the new node so the inspector opens
	// on it immediately. New authors don't have to discover "click the node
	// you just added" — the next move is staged for them.
	const handleAddStep = useCallback(
		(
			type: RoutineStep["type"],
			presetAction?: RoutineDeckAction,
			presetKind?: "if",
		) => {
			const currentSpec = specRef.current;
			const existingIds = currentSpec.steps.map((s) => s.id);
			const newStep = scaffoldStep(type, existingIds, presetAction, presetKind);
			const next = applyAddNodeAtBottom(currentSpec, newStep);
			onChange(next);
			setSelectedStepId(newStep.id);
			// Stash the new id locally so StepNode renders branch handles before
			// the first branch edge is wired. Persisted-through-edges once the
			// user draws one.
			if (presetKind === "if") {
				setIfNodeIds((prev) => {
					const next = new Set(prev);
					next.add(newStep.id);
					return next;
				});
			}
		},
		[onChange],
	);

	// Inspector edit: rebuild the spec via replaceStep, which already cascades
	// id renames through `layout.nodes` + `layout.edges`. If the id changed,
	// keep the selection pointing at the NEW id so the inspector stays open.
	const handleInspectorChange = useCallback(
		(nextStep: RoutineStep) => {
			const currentSpec = specRef.current;
			const idx = currentSpec.steps.findIndex(
				(s) => s.id === selectedStepIdRef.current,
			);
			if (idx < 0) return;
			const nextSpec = replaceStep(currentSpec, idx, nextStep);
			onChange(nextSpec);
			if (currentSpec.steps[idx]!.id !== nextStep.id) {
				setSelectedStepId(nextStep.id);
			}
		},
		[onChange],
	);

	const handleInspectorClose = useCallback(() => {
		setSelectedStepId(null);
		// Also clear React Flow's internal selection flag so the node ring
		// goes away when the inspector closes.
		setNodes((prev) =>
			prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
		);
	}, [setNodes]);

	const handleInspectorDelete = useCallback(() => {
		const currentSpec = specRef.current;
		const idx = currentSpec.steps.findIndex(
			(s) => s.id === selectedStepIdRef.current,
		);
		if (idx < 0) return;
		onChange(removeStep(currentSpec, idx));
		setSelectedStepId(null);
	}, [onChange]);

	const selectedStep = useMemo(() => {
		if (!selectedStepId) return null;
		return spec.steps.find((s) => s.id === selectedStepId) ?? null;
	}, [spec.steps, selectedStepId]);

	const empty = nodes.length === 0;
	const existingIds = useMemo(() => spec.steps.map((s) => s.id), [spec.steps]);

	// T-77: at viewport >= 1100px the inspector becomes a flex sibling of the
	// canvas, so the React Flow viewport shrinks when it opens and grows back
	// when it closes. Re-fit on each transition so the graph stays centered.
	// Below 1100px the inspector is a drawer overlay; canvas keeps full width
	// so no fit is needed.
	const isWide = useMediaQuery(WIDE_VIEWPORT_QUERY);
	const inlineInspectorOpen = selectedStep !== null && isWide;
	const drawerInspectorOpen = selectedStep !== null && !isWide;
	useEffect(() => {
		if (!isWide) return;
		// Two rAFs: the first lets the flex reflow land, the second lets React
		// Flow's internal ResizeObserver pick up the new dimensions before we
		// ask it to fit. With only one rAF, fitView reads the stale viewport
		// width and the graph ends up clustered in the wrong half.
		let inner = 0;
		const outer = requestAnimationFrame(() => {
			inner = requestAnimationFrame(() => {
				rf.fitView({ ...FIT_VIEW_OPTIONS, duration: 200 });
			});
		});
		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	}, [inlineInspectorOpen, isWide, rf]);

	return (
		<div className="routine-canvas relative flex h-full w-full">
			<div className="relative h-full flex-1 min-w-0">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={handleNodesChange}
					onEdgesChange={handleEdgesChange}
					onSelectionChange={handleSelectionChange}
					onConnect={handleConnect}
					nodeTypes={NODE_TYPES}
					edgeTypes={EDGE_TYPES}
					fitView
					fitViewOptions={FIT_VIEW_OPTIONS}
					proOptions={{ hideAttribution: true }}
					minZoom={0.25}
					maxZoom={2}
					nodesDraggable
					nodesConnectable
					elementsSelectable
				>
					<Background
						variant={BackgroundVariant.Dots}
						gap={20}
						size={1}
						className="!bg-paper"
					/>
					<Controls
						position="bottom-right"
						showInteractive={false}
						className="!border !border-line !bg-paper-2 !shadow-sm"
					/>
					<MiniMap
						position="bottom-left"
						nodeStrokeWidth={2}
						maskColor="rgb(var(--paper) / 0.7)"
						className="!border !border-line !bg-paper-2"
						pannable
						zoomable
					/>
				</ReactFlow>
				<AddStepPalette onAdd={handleAddStep} />
				{runs && runs.length > 0 && onSelectRun ? (
					<RunOverlayPicker
						runs={runs}
						selectedRunId={selectedRunId ?? null}
						onSelect={onSelectRun}
					/>
				) : null}
				{compileErrors && compileErrors.length > 0 ? (
					<CompileErrorStrip errors={compileErrors} />
				) : null}
				{empty ? (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
						<div className="rounded border border-dashed border-line bg-paper-2/80 px-4 py-3 text-center font-mono text-2xs text-ink-3">
							No steps yet.
							<br />
							Click <span className="font-semibold text-ink-2">+ Add step</span> above to begin.
						</div>
					</div>
				) : null}
			</div>
			{inlineInspectorOpen ? (
				<StepInspector
					step={selectedStep}
					existingIds={existingIds}
					onChange={handleInspectorChange}
					onClose={handleInspectorClose}
					onDelete={handleInspectorDelete}
					mode="inline"
					isIfNode={selectedStep ? isIfNode(selectedStep.id) : false}
					stepRun={selectedStep ? stepRunsByStepId?.get(selectedStep.id) : undefined}
					routineId={routineId}
					selectedRunId={selectedRunId ?? null}
				/>
			) : null}
			{drawerInspectorOpen ? (
				<>
					<div
						onClick={handleInspectorClose}
						aria-hidden="true"
						className="fixed inset-0 z-20 bg-ink/20"
					/>
					<StepInspector
						step={selectedStep}
						existingIds={existingIds}
						onChange={handleInspectorChange}
						onClose={handleInspectorClose}
						onDelete={handleInspectorDelete}
						mode="drawer"
						isIfNode={selectedStep ? isIfNode(selectedStep.id) : false}
						stepRun={selectedStep ? stepRunsByStepId?.get(selectedStep.id) : undefined}
						routineId={routineId}
						selectedRunId={selectedRunId ?? null}
					/>
				</>
			) : null}
		</div>
	);
}

/**
 * Merge committed drag positions into the spec's `layout.nodes`, preserving
 * existing layout edges and per-node metadata (e.g. `collapsed`). Positions are
 * rounded to integers so YAML diffs stay clean.
 *
 * Steps that were dragged but not yet in `layout.nodes` get a fresh entry.
 * Orphan `layout.nodes` entries (no matching step id) are pruned so a save
 * does not preserve dead positions for deleted steps.
 *
 * Returns the original spec reference when nothing meaningful changed.
 */
export function applyPositionCommits(
	spec: RoutineSpec,
	commits: ReadonlyArray<NodePositionChange>,
): RoutineSpec {
	const validSteps = new Set(spec.steps.map((s) => s.id));
	const prev = spec.layout?.nodes ?? {};
	const next: Record<string, { x: number; y: number; collapsed?: boolean }> = {};

	// Carry over existing entries (keyed by step id), pruning orphans.
	for (const [id, entry] of Object.entries(prev)) {
		if (!validSteps.has(id)) continue;
		next[id] = { ...entry };
	}

	let mutated = false;
	for (const change of commits) {
		if (!validSteps.has(change.id)) continue;
		const pos = change.position;
		if (!pos) continue;
		const x = Math.round(pos.x);
		const y = Math.round(pos.y);
		const existing = next[change.id];
		if (existing && existing.x === x && existing.y === y) continue;
		next[change.id] = existing ? { ...existing, x, y } : { x, y };
		mutated = true;
	}

	if (!mutated) return spec;

	const layout: RoutineLayout = {
		version: 1,
		nodes: next,
		...(spec.layout?.edges?.length ? { edges: spec.layout.edges } : {}),
	};
	return { ...spec, layout };
}

/**
 * Floating strip pinned above the React Flow Controls. Lists up to 3 compile
 * errors verbatim so the user sees what's blocking save without leaving the
 * canvas. Additional errors collapse into a `+N more` tail.
 *
 * Pointer-events are enabled so the user can hover for full messages, but the
 * strip never intercepts drag/zoom gestures — it's small and bottom-pinned.
 */
function CompileErrorStrip({
	errors,
}: {
	errors: ReadonlyArray<CompileError>;
}): JSX.Element {
	const visible = errors.slice(0, 3);
	const overflow = errors.length - visible.length;
	return (
		<div
			className="pointer-events-auto absolute inset-x-3 bottom-3 z-20 flex flex-col gap-1 sm:left-1/2 sm:right-auto sm:max-w-xl sm:-translate-x-1/2"
			role="alert"
		>
			{visible.map((err, idx) => (
				<div
					key={idx}
					className="flex items-center gap-2 rounded border border-danger/50 bg-danger/10 px-3 py-1.5 font-mono text-2xs text-danger shadow-sm"
					title={err.message}
				>
					<span className="font-bold">!</span>
					<span className="truncate">{err.message}</span>
				</div>
			))}
			{overflow > 0 ? (
				<div className="rounded border border-danger/40 bg-danger/5 px-3 py-1 text-center font-mono text-2xs text-danger">
					+{overflow} more
				</div>
			) : null}
		</div>
	);
}

/**
 * T-71: floating last-run picker. Top-right of the viewport so it doesn't
 * fight the AddStepPalette (top-left). Renders only when the routine has
 * any runs at all; a `<select>` keeps the surface tiny and keyboard-native
 * without pulling in a popover library.
 *
 * The visible label shows started-at + status so the user can navigate by
 * "what ran when" rather than opaque run ids.
 */
function RunOverlayPicker({
	runs,
	selectedRunId,
	onSelect,
}: {
	runs: ReadonlyArray<RoutineRun>;
	selectedRunId: string | null;
	onSelect: (id: string | null) => void;
}): JSX.Element {
	return (
		<div className="pointer-events-auto absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded border border-line bg-paper-2/95 px-2 py-1 shadow-sm">
			<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
				run
			</span>
			<select
				value={selectedRunId ?? ""}
				onChange={(e) => onSelect(e.target.value || null)}
				className="field h-6 max-w-[220px] truncate font-mono text-2xs"
				aria-label="Select run to overlay"
			>
				{runs.map((r) => (
					<option key={r.id} value={r.id}>
						{formatRunLabel(r)}
					</option>
				))}
			</select>
		</div>
	);
}

function formatRunLabel(run: RoutineRun): string {
	const status = !run.endedAt
		? "running"
		: run.abortReason
			? "aborted"
			: run.exitCode === 0
				? "ok"
				: "fail";
	const ts = run.startedAt;
	// "MM-DD HH:MM" — short enough for a 220px select, precise enough to
	// disambiguate adjacent runs.
	const date = new Date(ts);
	const pad = (n: number): string => n.toString().padStart(2, "0");
	const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return `${stamp} · ${status}`;
}
