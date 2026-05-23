/**
 * Unit tests for `applyPositionCommits` — the drag-end → layout reducer.
 * Covers:
 *   1. First drag on a layout-less spec creates a fresh `layout.nodes` entry.
 *   2. Subsequent drag updates the existing entry, preserving `collapsed`.
 *   3. Same-position re-commit returns the SAME spec reference (no-op).
 *   4. Drag of an unknown step id is ignored (defensive).
 *   5. Existing `layout.edges` are carried through verbatim on a drag commit.
 *   6. Orphan `layout.nodes` entries (no matching step id) are pruned out.
 */

import { describe, expect, test } from "bun:test";

import type { NodePositionChange } from "@xyflow/react";

import type { RoutineSpec } from "@omp-deck/protocol";

import { applyPositionCommits } from "./RoutineCanvas";

function commit(id: string, x: number, y: number): NodePositionChange {
	return { type: "position", id, position: { x, y }, dragging: false };
}

const baseSpec: RoutineSpec = {
	name: "drag-test",
	trigger: [{ manual: {} }],
	steps: [
		{ id: "a", type: "wait", duration_secs: 1 },
		{ id: "b", type: "wait", duration_secs: 1 },
	],
};

describe("applyPositionCommits", () => {
	test("first drag on a layout-less spec creates layout.nodes", () => {
		const next = applyPositionCommits(baseSpec, [commit("a", 123.4, 56.7)]);
		expect(next).not.toBe(baseSpec);
		expect(next.layout?.version).toBe(1);
		expect(next.layout?.nodes?.a).toEqual({ x: 123, y: 57 });
		expect(next.layout?.nodes?.b).toBeUndefined();
	});

	test("subsequent drag updates existing entry, preserving collapsed", () => {
		const withLayout: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: { a: { x: 0, y: 0, collapsed: true } },
			},
		};
		const next = applyPositionCommits(withLayout, [commit("a", 200, 300)]);
		expect(next.layout?.nodes?.a).toEqual({ x: 200, y: 300, collapsed: true });
	});

	test("same-position re-commit returns the SAME spec reference (no churn)", () => {
		const withLayout: RoutineSpec = {
			...baseSpec,
			layout: { version: 1, nodes: { a: { x: 100, y: 200 } } },
		};
		const next = applyPositionCommits(withLayout, [commit("a", 100, 200)]);
		expect(next).toBe(withLayout);
	});

	test("drag of an unknown step id is ignored", () => {
		const next = applyPositionCommits(baseSpec, [commit("ghost", 50, 60)]);
		expect(next).toBe(baseSpec);
	});

	test("existing layout.edges are carried through on commit", () => {
		const withEdges: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		const next = applyPositionCommits(withEdges, [commit("a", 10, 20)]);
		expect(next.layout?.edges).toEqual([{ from: "a", to: "b", kind: "success" }]);
		expect(next.layout?.nodes?.a).toEqual({ x: 10, y: 20 });
	});

	test("orphan layout.nodes entries are pruned even when committing for a different step", () => {
		const stale: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: {
					a: { x: 0, y: 0 },
					deleted_step: { x: 999, y: 999 },
				},
			},
		};
		const next = applyPositionCommits(stale, [commit("a", 50, 60)]);
		expect(next.layout?.nodes?.a).toEqual({ x: 50, y: 60 });
		expect(next.layout?.nodes?.deleted_step).toBeUndefined();
	});

	test("rounds float positions to integers", () => {
		const next = applyPositionCommits(baseSpec, [commit("a", 1.49, 2.51)]);
		expect(next.layout?.nodes?.a).toEqual({ x: 1, y: 3 });
	});

	test("mid-drag (dragging=true) changes are not consumed by this reducer", () => {
		// applyPositionCommits is only ever called with already-filtered
		// `dragging === false` commits — but defensively, a caller that hands
		// us a dragging:true change should not mutate state. We model that by
		// checking the type guard in the canvas; here we assert the reducer
		// itself treats malformed entries (no position) as a no-op.
		const malformed = [{ type: "position", id: "a", dragging: false } as NodePositionChange];
		const next = applyPositionCommits(baseSpec, malformed);
		expect(next).toBe(baseSpec);
	});
});
