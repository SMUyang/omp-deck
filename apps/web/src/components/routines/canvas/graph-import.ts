/**
 * Derive a React Flow graph (`nodes` + `edges`) from a `RoutineSpec`.
 *
 * Node placement:
 * - `spec.layout.nodes[id]` wins when present; otherwise fall back to a
 *   vertical stack `{ x: CANVAS_DEFAULT_X, y: i * GAP }`.
 *
 * Edges (rendered in this order, deduped on the {source,target} pair):
 *   1. **Explicit** edges from `spec.layout.edges` — fully owned by the user.
 *      Deletable. Bypass step 2 entirely (the user "owns" the wiring).
 *   2. **Inferred sequential** — `step[i] -> step[i+1]` for every adjacent
 *      pair. Drawn ONLY when no explicit edges exist (`spec.layout.edges`
 *      empty or absent). Dashed; NOT deletable (would just reappear on the
 *      next import — instead the user lifts them via T-66's `applyEdgeConnection`).
 *   3. **Inferred `when:` cross-refs** — for every step whose `when:` mentions
 *      `steps.<other>` where `<other>` isn't already wired by (1) or (2),
 *      draw a dashed `manual`-kind edge from `<other>` to the step. Always
 *      drawn (independent of explicit edges) so the visual graph reflects
 *      the actual data dependencies the runtime evaluates.
 *
 * Inferred edges are NOT persisted. Only `layout.edges` round-trips through
 * YAML; everything else is recomputed from `spec.steps` on every import.
 */
import type {
	RoutineLayoutEdge,
	RoutineLayoutEdgeKind,
	RoutineSpec,
} from "@omp-deck/protocol";

import {
	CANVAS_DEFAULT_X,
	CANVAS_NODE_VERTICAL_GAP,
	type SequentialEdge,
	type StepNode,
} from "./graph-types";

export interface ImportedGraph {
	nodes: StepNode[];
	edges: SequentialEdge[];
}

/**
 * `when:` expressions are JS-ish and reference steps as `steps.<id>.<field>`.
 * This regex captures `<id>` for any such reference. Identifiers follow the
 * step-id schema (`^[a-z][a-z0-9_-]*$`) so the character class is safe.
 */
const STEPS_REFERENCE_RE = /\bsteps\.([a-z][a-z0-9_-]*)\b/g;

/**
 * Build the canvas-side graph from a `RoutineSpec`.
 */
export function importFromSpec(spec: RoutineSpec): ImportedGraph {
	const nodes = buildNodes(spec);

	const explicit = spec.layout?.edges?.length
		? buildExplicitEdges(spec, spec.layout.edges)
		: [];

	const sequential = explicit.length === 0 ? buildSequentialInferred(spec) : [];

	// `when:` derived edges complement whichever of (explicit, sequential)
	// fired above. Skip any `from->to` pair already covered to avoid stacking.
	const drawn = new Set<string>();
	for (const e of explicit) drawn.add(`${e.source}->${e.target}`);
	for (const e of sequential) drawn.add(`${e.source}->${e.target}`);
	const whenEdges = buildWhenInferred(spec, drawn);

	return { nodes, edges: [...explicit, ...sequential, ...whenEdges] };
}

function buildNodes(spec: RoutineSpec): StepNode[] {
	const layoutNodes = spec.layout?.nodes ?? {};
	return spec.steps.map((step, index) => {
		const saved = layoutNodes[step.id];
		const inferred = !saved;
		const position = saved
			? { x: saved.x, y: saved.y }
			: { x: CANVAS_DEFAULT_X, y: index * CANVAS_NODE_VERTICAL_GAP };
		const node: StepNode = {
			id: step.id,
			type: "step",
			position,
			data: { step, inferredPosition: inferred },
		};
		return node;
	});
}

/**
 * Compile explicit `layout.edges` into renderable edges. Anything pointing at
 * a missing step id is dropped silently — the validator already surfaces those
 * as `crossRef` errors, so we should not also crash the canvas.
 *
 * Explicit edges are `deletable: true` (the user can remove them via React
 * Flow's keyboard / context menu / programmatic removal).
 */
function buildExplicitEdges(
	spec: RoutineSpec,
	layoutEdges: readonly RoutineLayoutEdge[],
): SequentialEdge[] {
	const knownIds = new Set(spec.steps.map((s) => s.id));
	const edges: SequentialEdge[] = [];
	for (let i = 0; i < layoutEdges.length; i++) {
		const e = layoutEdges[i];
		if (!e) continue;
		if (!knownIds.has(e.from) || !knownIds.has(e.to)) continue;
		const kind: RoutineLayoutEdgeKind = e.kind ?? "success";
		edges.push({
			id: edgeId(e.from, e.to, kind, i),
			type: "sequential",
			source: e.from,
			target: e.to,
			data: { kind, inferred: false },
			deletable: true,
			...(e.label ? { label: e.label } : {}),
		});
	}
	return edges;
}

/**
 * Synthesize `step[i] -> step[i+1]` edges for a linear routine that has not
 * been laid out yet. Marked `inferred: true` (renders dashed) and
 * `deletable: false` so attempts to remove them are a no-op — to "remove" a
 * sequential edge the user creates an explicit one (which lifts the
 * sequentials into `layout.edges` and exposes them as deletable).
 */
function buildSequentialInferred(spec: RoutineSpec): SequentialEdge[] {
	const edges: SequentialEdge[] = [];
	for (let i = 1; i < spec.steps.length; i++) {
		const prev = spec.steps[i - 1];
		const curr = spec.steps[i];
		if (!prev || !curr) continue;
		edges.push({
			id: edgeId(prev.id, curr.id, "success", i),
			type: "sequential",
			source: prev.id,
			target: curr.id,
			data: { kind: "success", inferred: true },
			deletable: false,
		});
	}
	return edges;
}

/**
 * Inferred dependency edges derived from `when:` expressions referencing
 * other steps. Always drawn (independent of explicit edges) so the visual
 * graph reflects actual runtime data dependencies. `drawnPairs` is a set of
 * `from->to` strings already covered by another edge layer; matching pairs
 * are skipped to avoid double-drawing.
 */
function buildWhenInferred(
	spec: RoutineSpec,
	drawnPairs: ReadonlySet<string>,
): SequentialEdge[] {
	const edges: SequentialEdge[] = [];
	const stepIds = new Set(spec.steps.map((s) => s.id));
	for (let i = 0; i < spec.steps.length; i++) {
		const step = spec.steps[i];
		if (!step?.when) continue;
		for (const referencedId of extractStepReferences(step.when)) {
			if (!stepIds.has(referencedId)) continue;
			if (referencedId === step.id) continue; // self-ref (rare); skip
			if (drawnPairs.has(`${referencedId}->${step.id}`)) continue;
			edges.push({
				id: edgeId(referencedId, step.id, "manual", 1000 + edges.length),
				type: "sequential",
				source: referencedId,
				target: step.id,
				data: { kind: "manual", inferred: true },
				deletable: false,
			});
		}
	}
	return edges;
}

/** Pull every `steps.<id>` reference out of a `when:` expression. */
function extractStepReferences(expression: string): Set<string> {
	const ids = new Set<string>();
	for (const match of expression.matchAll(STEPS_REFERENCE_RE)) {
		const id = match[1];
		if (id) ids.add(id);
	}
	return ids;
}

/** Stable edge id — React Flow needs them unique per render. */
function edgeId(from: string, to: string, kind: RoutineLayoutEdgeKind, salt: number): string {
	return `e:${from}->${to}:${kind}:${salt}`;
}
