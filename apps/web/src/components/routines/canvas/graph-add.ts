/**
 * Helpers for adding a fresh step to a canvas-mode routine spec.
 *
 * T-64 ships the toolbar palette: clicking a typed button creates a new step
 * via `scaffoldStep`, inserts it at the end of `spec.steps`, and stamps a
 * non-overlapping position into `spec.layout.nodes` so the new node lands
 * visibly below everything already on the canvas.
 *
 * Placement contract: position is `(CANVAS_DEFAULT_X, maxBottomY +
 * CANVAS_NODE_VERTICAL_GAP)` where `maxBottomY` is the largest Y a node would
 * occupy under `graph-import.ts`'s buildNodes(). That covers both saved
 * `layout.nodes[id].y` and the inferred `index * GAP` fallback used by
 * un-positioned imports — so the new node lands below whatever is visible,
 * regardless of which mix of saved/inferred nodes the spec currently has.
 */

import type {
	RoutineLayout,
	RoutineLayoutNode,
	RoutineSpec,
	RoutineStep,
} from "@omp-deck/protocol";

import { insertStep } from "../spec-yaml";
import { CANVAS_DEFAULT_X, CANVAS_NODE_VERTICAL_GAP } from "./graph-types";

/**
 * The Y coordinate the next inserted node should occupy. Mirrors the placement
 * rules used by `buildNodes` for un-positioned steps: index-based for steps
 * without a `layout.nodes` entry, persisted Y for steps with one.
 *
 * Empty spec → `0`. First "add" then lands at `(CANVAS_DEFAULT_X, 0 + GAP)`,
 * which keeps a one-step canvas centered around the same line as the empty
 * placeholder used to occupy.
 */
export function computeNextNodeY(spec: RoutineSpec): number {
	if (spec.steps.length === 0) return 0;
	const saved = spec.layout?.nodes ?? {};
	let maxY = -Infinity;
	spec.steps.forEach((step, index) => {
		const entry = saved[step.id];
		const y = entry ? entry.y : index * CANVAS_NODE_VERTICAL_GAP;
		if (y > maxY) maxY = y;
	});
	if (!Number.isFinite(maxY)) return 0;
	return maxY + CANVAS_NODE_VERTICAL_GAP;
}

/**
 * Insert `step` at the end of `spec.steps` and persist a layout entry for it.
 *
 * - X defaults to `CANVAS_DEFAULT_X` (canvas centerline).
 * - Y defaults to `computeNextNodeY(spec)` so the new node clears anything
 *   currently visible — both saved and inferred positions are considered.
 * - The position is rounded to integers (matches `applyPositionCommits`).
 * - Existing `layout.edges` and per-node `collapsed` flags are carried through
 *   verbatim. Orphan node entries are NOT pruned here — drag-commit / save is
 *   the right place for that, and pruning during an insert would be a
 *   surprising side effect.
 *
 * Returns a NEW spec object — never mutates the input.
 */
export function applyAddNodeAtBottom(
	spec: RoutineSpec,
	step: RoutineStep,
	overrides?: { x?: number; y?: number },
): RoutineSpec {
	const withStep = insertStep(spec, step);
	const x = Math.round(overrides?.x ?? CANVAS_DEFAULT_X);
	const y = Math.round(overrides?.y ?? computeNextNodeY(spec));

	const prevNodes = withStep.layout?.nodes ?? {};
	const nextEntry: RoutineLayoutNode = { x, y };
	const nodes: Record<string, RoutineLayoutNode> = {
		...prevNodes,
		[step.id]: nextEntry,
	};

	const layout: RoutineLayout = {
		version: 1,
		nodes,
		...(withStep.layout?.edges?.length
			? { edges: withStep.layout.edges }
			: {}),
	};
	return { ...withStep, layout };
}
