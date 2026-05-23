/**
 * Internal types for the V2 routine canvas.
 *
 * The canvas presents a `RoutineSpec` as a React Flow graph — nodes correspond
 * to step ids, edges live in `layout.edges`. These types are the "react-flow
 * shape" version of the spec: we keep the source-of-truth on the protocol-side
 * (`RoutineSpec.steps` + `RoutineSpec.layout`) and derive these only at render
 * time via `graph-import` (P1.3).
 */

import type { Node, Edge } from "@xyflow/react";

import type { RoutineLayoutEdgeKind, RoutineStep, RoutineStepRun } from "@omp-deck/protocol";

/**
 * Per-node payload attached to React Flow nodes. Carries the originating
 * `RoutineStep` so the StepNode renderer can pull whichever fields it needs
 * to display a one-line summary without re-fetching from the parent spec.
 */
export interface StepNodeData extends Record<string, unknown> {
	step: RoutineStep;
	/** Marker set by `graph-import` when no explicit `layout.nodes[id]` existed. */
	inferredPosition: boolean;
	/**
	 * Set by `RoutineCanvas` (post-import) when the graph compiler flags this
	 * step. Carries the most relevant error message so the StepNode renderer
	 * can show a red ring + tooltip without re-running compile per render.
	 */
	compileError?: string;
	/**
	 * Canvas-only "if-flavored" marker. True when the node should render with
	 * two labeled source handles (`true` / `false`) wired to compile branch
	 * `when:` gates downstream. Derived from outgoing edges with
	 * `kind: "true" | "false"` and from a canvas-local set tracking nodes
	 * the user just added via the "+ if" palette entry. Never serialized.
	 */
	isIfNode?: boolean;
	/**
	 * T-71: run overlay payload. Set by `RoutineCanvas` whenever the parent
	 * supplies a `stepRunsByStepId` map. Drives the ring color, status pill,
	 * duration, and (for agent steps) model/cost badges in StepNode.
	 *
	 * Undefined when the routine has never run, or the selected historical run
	 * has no record for this step yet (e.g. early-aborted runs).
	 */
	stepRun?: RoutineStepRun;
}

/** Per-edge payload. `kind` mirrors `RoutineLayoutEdge.kind`; `inferred` flags edges that came from `graph-import` rather than the saved layout. */
export interface SequentialEdgeData extends Record<string, unknown> {
	kind: RoutineLayoutEdgeKind;
	inferred: boolean;
}

/** Narrow React Flow's generic node/edge types to the shapes the canvas uses. */
export type StepNode = Node<StepNodeData, "step">;
export type SequentialEdge = Edge<SequentialEdgeData, "sequential">;

/** Layout grid constants — used by P1.3 graph-import and the canvas toolbar. */
export const CANVAS_DEFAULT_X = 280;
export const CANVAS_NODE_VERTICAL_GAP = 220;
