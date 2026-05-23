/**
 * Compile a canvas-authored routine graph into a valid linear `steps:` array.
 *
 * The V1 runtime engine walks `RoutineSpec.steps` in array order; `layout.edges`
 * is purely visual. To make explicit-graph authoring meaningful, the canvas
 * needs a save-time pass that:
 *
 *   1. Validates the graph (duplicate ids, dangling edges, self-loops, cycles).
 *   2. Topologically sorts the steps so the array order respects every edge.
 *   3. Compiles branch edges (`kind: "true"` / `kind: "false"`) into `when:`
 *      gates on the target step. Multiple branches AND-merge; if the target
 *      already has a `when:`, the existing expression is preserved and ANDed
 *      with each branch clause.
 *
 * The compiler ONLY consults `spec.layout.edges`. `when:`-derived inferred
 * dependencies (drawn by `graph-import` as dashed `manual` edges) are
 * visualization-only — the user composes them by writing `when:` directly,
 * not by drawing edges.
 *
 * Stability: when multiple nodes are simultaneously eligible in Kahn's
 * algorithm, ties break on original `spec.steps` index so a save followed by
 * a reopen produces the same compiled order.
 *
 * Linear case (no explicit edges): compile is the identity function. No graph
 * to validate, original order preserved.
 */

import type { RoutineLayoutEdgeKind, RoutineSpec, RoutineStep } from "@omp-deck/protocol";

export type CompileErrorCode =
	| "duplicate-id"
	| "missing-target"
	| "self-loop"
	| "cycle";

export interface CompileError {
	code: CompileErrorCode;
	/** Human-readable, surfaced verbatim on the canvas error strip. */
	message: string;
	/** Step ids implicated by this error. Drives the red-ring overlay on nodes. */
	nodeIds: string[];
}

export interface CompileResult {
	/**
	 * Topo-sorted steps respecting every explicit edge. When the graph has a
	 * cycle or other blocking error, returns the original order so the caller
	 * does not crash; gate persistence on `errors.length === 0`.
	 */
	steps: RoutineStep[];
	errors: CompileError[];
}

/**
 * Compile a `RoutineSpec` to a linear step order matching its `layout.edges`.
 *
 * Returns the original spec.steps order (and an empty errors array) when no
 * explicit edges exist — the linear authoring path is unaffected.
 */
export function compileGraph(spec: RoutineSpec): CompileResult {
	const errors: CompileError[] = [];

	// ── 1. Duplicate-id check ──────────────────────────────────────────────
	// Ajv catches this on full schema validation, but the canvas can stage a
	// rename mid-edit. A direct check avoids spurious cycle / missing-target
	// errors downstream when two nodes share an id.
	const idCounts = new Map<string, number>();
	for (const step of spec.steps) {
		idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
	}
	for (const [id, count] of idCounts) {
		if (count > 1) {
			errors.push({
				code: "duplicate-id",
				message: `Duplicate step id "${id}" (appears ${count}×)`,
				nodeIds: [id],
			});
		}
	}

	const idIndex = new Map<string, number>();
	for (let i = 0; i < spec.steps.length; i++) {
		// First occurrence wins for index lookup; duplicates already error'd.
		const id = spec.steps[i]!.id;
		if (!idIndex.has(id)) idIndex.set(id, i);
	}
	const knownIds = new Set(idIndex.keys());

	const layoutEdges = spec.layout?.edges ?? [];

	// ── Linear short-circuit ───────────────────────────────────────────────
	// No explicit edges → spec.steps already encodes the run order, no branch
	// gates to derive. Compile is the identity.
	if (layoutEdges.length === 0) {
		return { steps: [...spec.steps], errors };
	}

	// ── 2. Edge target validation ──────────────────────────────────────────
	// Collect missing-target ids deduped (one error per orphan reference,
	// regardless of how many edges name it). Self-loops are a separate code
	// because they cannot be auto-resolved by reordering.
	const missingTargets = new Set<string>();
	const validEdges: Array<{ from: string; to: string; kind: RoutineLayoutEdgeKind }> = [];
	for (const edge of layoutEdges) {
		const fromKnown = knownIds.has(edge.from);
		const toKnown = knownIds.has(edge.to);
		if (!fromKnown) missingTargets.add(edge.from);
		if (!toKnown) missingTargets.add(edge.to);
		if (!fromKnown || !toKnown) continue;
		if (edge.from === edge.to) {
			errors.push({
				code: "self-loop",
				message: `Step "${edge.from}" has an edge to itself`,
				nodeIds: [edge.from],
			});
			continue;
		}
		validEdges.push({ from: edge.from, to: edge.to, kind: edge.kind ?? "success" });
	}
	// Sort for deterministic error order — keeps test snapshots stable.
	for (const id of [...missingTargets].sort()) {
		errors.push({
			code: "missing-target",
			message: `Edge references unknown step "${id}"`,
			nodeIds: [id],
		});
	}

	// ── 3. Build adjacency. Multi-edge between the same pair collapses to one
	// so a graph with both a `success` and a `manual` edge from A→B contributes
	// in-degree 1 to B (not 2). The runtime cares about ordering, not edge
	// multiplicity.
	const adj = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	for (const id of knownIds) {
		adj.set(id, []);
		indeg.set(id, 0);
	}
	const seenEdge = new Set<string>();
	for (const e of validEdges) {
		const key = `${e.from}\u0000${e.to}`;
		if (seenEdge.has(key)) continue;
		seenEdge.add(key);
		adj.get(e.from)!.push(e.to);
		indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	}

	// ── 4. Stable Kahn's algorithm ──────────────────────────────────────────
	// Ready set is kept sorted by original spec index so ties resolve in the
	// order the user authored the steps — least surprising for diff review.
	const ready: number[] = [];
	for (const [id, deg] of indeg) {
		if (deg === 0) insertSorted(ready, idIndex.get(id)!);
	}

	const order: string[] = [];
	while (ready.length > 0) {
		const idx = ready.shift()!;
		const id = spec.steps[idx]!.id;
		order.push(id);
		for (const next of adj.get(id) ?? []) {
			const d = (indeg.get(next) ?? 0) - 1;
			indeg.set(next, d);
			if (d === 0) insertSorted(ready, idIndex.get(next)!);
		}
	}

	// ── 5. Cycle detection ─────────────────────────────────────────────────
	// Any node still carrying in-degree > 0 sits in a cycle (or downstream of
	// one). Report all of them in a single error so the user sees the full
	// affected set on the canvas at once.
	const cycleIds: string[] = [];
	for (const [id, d] of indeg) {
		if (d > 0) cycleIds.push(id);
	}
	if (cycleIds.length > 0) {
		cycleIds.sort((a, b) => idIndex.get(a)! - idIndex.get(b)!);
		errors.push({
			code: "cycle",
			message: `Cycle detected involving: ${cycleIds.join(", ")}`,
			nodeIds: cycleIds,
		});
		// Cycle blocks save; hand back original order so callers don't crash.
		return { steps: [...spec.steps], errors };
	}

	// ── 6. Branch compilation ──────────────────────────────────────────────
	// `kind: "true"` / `kind: "false"` edges from an if-flavored source compile
	// into a `when:` gate on the target: `steps.<source>.json === true|false`.
	// Multiple branch edges into the same target AND-merge; an existing `when:`
	// on the target is preserved by ANDing it on the left.
	const branchClauses = new Map<string, string[]>();
	for (const e of validEdges) {
		if (e.kind !== "true" && e.kind !== "false") continue;
		const clause = `steps.${e.from}.json === ${e.kind}`;
		const list = branchClauses.get(e.to);
		if (list) list.push(clause);
		else branchClauses.set(e.to, [clause]);
	}

	// ── 7. Map sorted ids back to step objects, applying branch when: ──────
	const byId = new Map(spec.steps.map((s) => [s.id, s]));
	const sortedSteps = order.map((id) => {
		const step = byId.get(id)!;
		const branches = branchClauses.get(id);
		if (!branches || branches.length === 0) return step;
		const merged = mergeWhen(step.when, branches);
		return { ...step, when: merged };
	});
	return { steps: sortedSteps, errors };
}

/**
 * Compose a target step's effective `when:` from its existing expression
 * (if any) plus N branch clauses. AND-merge with each operand parenthesized
 * to avoid precedence surprises (sandbox parses standard JS, so `&&`
 * dominates `||` — but we don't trust the user's expression to play nice
 * with that, so wrap conservatively).
 *
 * Format:
 *   - 1 branch, no existing  → `clause`
 *   - N>1 branches, no existing → `(c1) && (c2) && ...`
 *   - existing + N branches → `(existing) && (c1) && (c2) && ...`
 */
function mergeWhen(
	existing: string | undefined,
	branches: ReadonlyArray<string>,
): string {
	const trimmedExisting = existing?.trim();
	if (!trimmedExisting && branches.length === 1) return branches[0]!;
	const parts: string[] = [];
	if (trimmedExisting) parts.push(`(${trimmedExisting})`);
	for (const b of branches) parts.push(`(${b})`);
	return parts.join(" && ");
}

/** Stable insertion into a numerically-sorted array. O(log n) lookup, O(n) splice. */
function insertSorted(arr: number[], value: number): void {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	arr.splice(lo, 0, value);
}
