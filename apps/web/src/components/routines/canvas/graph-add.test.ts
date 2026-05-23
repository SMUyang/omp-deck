/**
 * Unit tests for `computeNextNodeY` + `applyAddNodeAtBottom` — the T-64
 * toolbar-add pipeline.
 *
 * Covers:
 *   1. Empty spec puts the first inserted node at y = 0 (centered).
 *   2. Layout-less spec with N steps puts the new node below the inferred
 *      `index * GAP` stack.
 *   3. Spec with persisted positions puts the new node below max persisted Y.
 *   4. Mixed (some saved, some inferred) considers both when picking max.
 *   5. `applyAddNodeAtBottom` writes layout.nodes for the new step, preserves
 *      existing layout.edges, and integer-rounds the coordinates.
 *   6. Custom `overrides.x`/`overrides.y` win over computed defaults.
 *   7. Helper never mutates the input spec.
 */

import { describe, expect, test } from "bun:test";

import type { RoutineSpec, RoutineStep } from "@omp-deck/protocol";

import { applyAddNodeAtBottom, computeNextNodeY } from "./graph-add";
import { CANVAS_DEFAULT_X, CANVAS_NODE_VERTICAL_GAP } from "./graph-types";

function wait(id: string, secs = 1): RoutineStep {
	return { id, type: "wait", duration_secs: secs };
}

function emptySpec(): RoutineSpec {
	return { name: "add-test", trigger: [{ manual: {} }], steps: [] };
}

describe("computeNextNodeY", () => {
	test("returns 0 for an empty spec", () => {
		expect(computeNextNodeY(emptySpec())).toBe(0);
	});

	test("returns last-inferred-bottom + GAP for a layout-less spec", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a"), wait("b"), wait("c")],
		};
		// inferred positions: a=0, b=GAP, c=2*GAP → max=2*GAP → next=3*GAP.
		expect(computeNextNodeY(spec)).toBe(3 * CANVAS_NODE_VERTICAL_GAP);
	});

	test("uses persisted Y when layout.nodes has an entry for a step", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a"), wait("b")],
			layout: {
				version: 1,
				nodes: {
					a: { x: 100, y: 50 },
					b: { x: 100, y: 999 },
				},
			},
		};
		expect(computeNextNodeY(spec)).toBe(999 + CANVAS_NODE_VERTICAL_GAP);
	});

	test("mixes saved + inferred positions when picking max", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a"), wait("b"), wait("c")],
			layout: {
				version: 1,
				nodes: {
					// b moved to a much-lower position than its inferred y=GAP.
					b: { x: 100, y: 5000 },
				},
			},
		};
		// inferred: a=0, c=2*GAP. Saved: b=5000. Max = 5000.
		expect(computeNextNodeY(spec)).toBe(5000 + CANVAS_NODE_VERTICAL_GAP);
	});
});

describe("applyAddNodeAtBottom", () => {
	test("appends the step and writes a fresh layout entry", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a"), wait("b")],
		};
		const next = applyAddNodeAtBottom(spec, wait("c"));
		expect(next.steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
		expect(next.layout?.version).toBe(1);
		expect(next.layout?.nodes?.c).toEqual({
			x: CANVAS_DEFAULT_X,
			y: 2 * CANVAS_NODE_VERTICAL_GAP,
		});
	});

	test("preserves existing layout.edges verbatim", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a"), wait("b")],
			layout: {
				version: 1,
				nodes: { a: { x: 10, y: 20 } },
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		const next = applyAddNodeAtBottom(spec, wait("c"));
		expect(next.layout?.edges).toEqual([
			{ from: "a", to: "b", kind: "success" },
		]);
		// Pre-existing layout entry for `a` is carried through unchanged.
		expect(next.layout?.nodes?.a).toEqual({ x: 10, y: 20 });
	});

	test("rounds the new position to integers", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a")],
			layout: { version: 1, nodes: { a: { x: 100, y: 123.45 } } },
		};
		const next = applyAddNodeAtBottom(spec, wait("b"));
		const entry = next.layout?.nodes?.b;
		expect(entry).toBeDefined();
		expect(Number.isInteger(entry!.x)).toBe(true);
		expect(Number.isInteger(entry!.y)).toBe(true);
		expect(entry!.y).toBe(Math.round(123.45 + CANVAS_NODE_VERTICAL_GAP));
	});

	test("overrides.x / overrides.y take precedence over computed defaults", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a")],
		};
		const next = applyAddNodeAtBottom(spec, wait("b"), { x: 777, y: 888 });
		expect(next.layout?.nodes?.b).toEqual({ x: 777, y: 888 });
	});

	test("does not mutate the input spec", () => {
		const spec: RoutineSpec = {
			...emptySpec(),
			steps: [wait("a")],
		};
		const before = JSON.stringify(spec);
		applyAddNodeAtBottom(spec, wait("b"));
		expect(JSON.stringify(spec)).toBe(before);
	});

	test("first add into an empty spec lands at (CANVAS_DEFAULT_X, 0)", () => {
		const next = applyAddNodeAtBottom(emptySpec(), wait("a"));
		expect(next.layout?.nodes?.a).toEqual({ x: CANVAS_DEFAULT_X, y: 0 });
		expect(next.steps).toHaveLength(1);
	});
});
