/**
 * Helpers for authoring edges on the canvas (T-66).
 *
 * Two pure reducers:
 *
 * - `applyEdgeConnection(spec, from, to, kind?)` — add an edge. If the spec
 *   has no explicit `layout.edges` yet, the previously-inferred sequential
 *   edges (`step[i] -> step[i+1]`) are **lifted** into `layout.edges` first
 *   so authoring a single connection doesn't make the rest of the wiring
 *   visually disappear (graph-import switches from inferred to explicit mode
 *   the moment `layout.edges` is non-empty).
 *
 * - `applyEdgeRemoval(spec, from, to, kind?)` — remove the matching explicit
 *   edge. If removing leaves `layout.edges` empty, the property is dropped
 *   entirely so the canvas falls back to inferred sequential rendering.
 *
 * Both reducers:
 *   - reject self-loops (`from === to`)
 *   - dedup against existing `(from, to, kind)` triples
 *   - return the original spec reference on no-op so React effects don't churn
 *   - default kind to `"success"` when omitted
 *
 * Authored `when:`-derived edges are NOT managed by these helpers — those are
 * always inferred from current `when:` expressions in graph-import.
 */

import type {
	RoutineLayout,
	RoutineLayoutEdge,
	RoutineLayoutEdgeKind,
	RoutineSpec,
} from "@omp-deck/protocol";

const DEFAULT_EDGE_KIND: RoutineLayoutEdgeKind = "success";

/**
 * Compute the inferred sequential edges for a layout-less spec — same shape
 * as `graph-import.buildSequentialInferred`, but emitting `RoutineLayoutEdge`
 * objects (no React Flow id / type fields). Used by `applyEdgeConnection` to
 * preserve the visual graph on the first explicit-edge author.
 */
function inferredSequentialLayoutEdges(spec: RoutineSpec): RoutineLayoutEdge[] {
	const edges: RoutineLayoutEdge[] = [];
	for (let i = 1; i < spec.steps.length; i++) {
		const prev = spec.steps[i - 1];
		const curr = spec.steps[i];
		if (!prev || !curr) continue;
		edges.push({ from: prev.id, to: curr.id, kind: "success" });
	}
	return edges;
}

/** True iff the given `(from, to, kind)` triple already appears in `edges`. */
function hasMatch(
	edges: ReadonlyArray<RoutineLayoutEdge>,
	from: string,
	to: string,
	kind: RoutineLayoutEdgeKind,
): boolean {
	return edges.some(
		(e) => e.from === from && e.to === to && (e.kind ?? "success") === kind,
	);
}

/**
 * Add an explicit edge to `spec.layout.edges`. See module doc for the lifting
 * contract.
 */
export function applyEdgeConnection(
	spec: RoutineSpec,
	from: string,
	to: string,
	kind: RoutineLayoutEdgeKind = DEFAULT_EDGE_KIND,
): RoutineSpec {
	if (from === to) return spec; // self-loop — silently ignore
	const knownIds = new Set(spec.steps.map((s) => s.id));
	if (!knownIds.has(from) || !knownIds.has(to)) return spec;

	const prevEdges = spec.layout?.edges ?? [];
	const lifted = prevEdges.length === 0 ? inferredSequentialLayoutEdges(spec) : prevEdges;
	if (hasMatch(lifted, from, to, kind)) return spec; // dedup → no-op

	const nextEdges: RoutineLayoutEdge[] = [...lifted, { from, to, kind }];
	const baseLayout = spec.layout ?? { version: 1, nodes: {} };
	const layout: RoutineLayout = { ...baseLayout, edges: nextEdges };
	return { ...spec, layout };
}

/**
 * Remove the matching explicit edge from `spec.layout.edges`. Returns the
 * original spec ref when nothing matches. When the last explicit edge is
 * removed, the `edges` property is dropped entirely so graph-import falls
 * back to inferred sequential rendering.
 */
export function applyEdgeRemoval(
	spec: RoutineSpec,
	from: string,
	to: string,
	kind: RoutineLayoutEdgeKind = DEFAULT_EDGE_KIND,
): RoutineSpec {
	const prev = spec.layout?.edges;
	if (!prev || prev.length === 0) return spec;
	const filtered = prev.filter(
		(e) =>
			!(e.from === from && e.to === to && (e.kind ?? "success") === kind),
	);
	if (filtered.length === prev.length) return spec; // nothing matched → no-op

	const baseLayout = spec.layout!;
	if (filtered.length === 0) {
		// Strip the now-empty edges property entirely so graph-import falls back
		// to inferred sequential edges. Keep layout.nodes (positions) intact.
		const { edges: _omit, ...rest } = baseLayout;
		return { ...spec, layout: { ...rest } as RoutineLayout };
	}
	return {
		...spec,
		layout: { ...baseLayout, edges: filtered },
	};
}
