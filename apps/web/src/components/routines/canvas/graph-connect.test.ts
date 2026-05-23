/**
 * Tests for `applyEdgeConnection` / `applyEdgeRemoval` — the T-66 edge-author
 * reducers.
 *
 * Covers:
 *   1. First connect on a layout-less spec LIFTS inferred sequentials + adds new.
 *   2. Connect on a spec that already has explicit edges just appends.
 *   3. Self-loop is rejected (returns same spec ref).
 *   4. Unknown source/target is rejected.
 *   5. Dedup: connecting an existing (from, to, kind) triple is a no-op.
 *   6. Default kind is `"success"`.
 *   7. Removal drops the matching edge, preserves the others.
 *   8. Removal that empties layout.edges strips the property entirely.
 *   9. Removal on an unknown edge is a no-op (same spec ref).
 *  10. Existing layout.nodes survive both connect and remove.
 */

import { describe, expect, test } from "bun:test";

import type { RoutineSpec, RoutineStep } from "@omp-deck/protocol";

import { applyEdgeConnection, applyEdgeRemoval } from "./graph-connect";

function wait(id: string): RoutineStep {
	return { id, type: "wait", duration_secs: 1 };
}

function threeStepSpec(): RoutineSpec {
	return {
		name: "edge-test",
		trigger: [{ manual: {} }],
		steps: [wait("a"), wait("b"), wait("c")],
	};
}

describe("applyEdgeConnection", () => {
	test("first connect on layout-less spec lifts inferred sequentials + adds new", () => {
		const spec = threeStepSpec();
		const next = applyEdgeConnection(spec, "a", "c", "manual");
		expect(next.layout?.edges).toEqual([
			{ from: "a", to: "b", kind: "success" },
			{ from: "b", to: "c", kind: "success" },
			{ from: "a", to: "c", kind: "manual" },
		]);
	});

	test("connect on spec with explicit edges only appends", () => {
		const spec: RoutineSpec = {
			...threeStepSpec(),
			layout: {
				version: 1,
				nodes: { a: { x: 0, y: 0 } },
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		const next = applyEdgeConnection(spec, "b", "c");
		expect(next.layout?.edges).toEqual([
			{ from: "a", to: "b", kind: "success" },
			{ from: "b", to: "c", kind: "success" },
		]);
		// Pre-existing nodes carried verbatim.
		expect(next.layout?.nodes).toEqual({ a: { x: 0, y: 0 } });
	});

	test("self-loop returns same spec reference (no-op)", () => {
		const spec = threeStepSpec();
		expect(applyEdgeConnection(spec, "a", "a")).toBe(spec);
	});

	test("unknown source/target returns same spec reference", () => {
		const spec = threeStepSpec();
		expect(applyEdgeConnection(spec, "a", "ghost")).toBe(spec);
		expect(applyEdgeConnection(spec, "ghost", "a")).toBe(spec);
	});

	test("dedup: existing (from, to, kind) triple returns same spec reference", () => {
		const spec: RoutineSpec = {
			...threeStepSpec(),
			layout: {
				version: 1,
				nodes: {},
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		expect(applyEdgeConnection(spec, "a", "b", "success")).toBe(spec);
	});

	test("dedup hit on inferred-but-not-yet-lifted edge also returns same spec ref", () => {
		// Layout-less spec has implied a->b. Authoring a->b should NOT lift +
		// then add — the edge is already visible via inference.
		const spec = threeStepSpec();
		expect(applyEdgeConnection(spec, "a", "b", "success")).toBe(spec);
	});

	test("default kind is success when omitted", () => {
		// Use a non-adjacent edge so the dedup against inferred-sequentials
		// doesn't short-circuit before the kind default is exercised.
		const spec = threeStepSpec();
		const next = applyEdgeConnection(spec, "a", "c");
		const newEdge = next.layout?.edges?.find(
			(e) => e.from === "a" && e.to === "c",
		);
		expect(newEdge?.kind).toBe("success");
	});

	test("creates a fresh layout when none exists, preserving spec.steps", () => {
		const spec = threeStepSpec();
		const next = applyEdgeConnection(spec, "a", "c", "manual");
		expect(next.layout?.version).toBe(1);
		expect(next.layout?.nodes).toEqual({});
		expect(next.steps).toBe(spec.steps);
	});
});

describe("applyEdgeRemoval", () => {
	function withEdges(): RoutineSpec {
		return {
			...threeStepSpec(),
			layout: {
				version: 1,
				nodes: { a: { x: 0, y: 0 } },
				edges: [
					{ from: "a", to: "b", kind: "success" },
					{ from: "b", to: "c", kind: "success" },
					{ from: "a", to: "c", kind: "manual" },
				],
			},
		};
	}

	test("removes the matching edge, preserves the rest", () => {
		const spec = withEdges();
		const next = applyEdgeRemoval(spec, "a", "c", "manual");
		expect(next.layout?.edges).toEqual([
			{ from: "a", to: "b", kind: "success" },
			{ from: "b", to: "c", kind: "success" },
		]);
		// layout.nodes carried through.
		expect(next.layout?.nodes).toEqual({ a: { x: 0, y: 0 } });
	});

	test("removing the last explicit edge strips the edges property", () => {
		const spec: RoutineSpec = {
			...threeStepSpec(),
			layout: {
				version: 1,
				nodes: { a: { x: 0, y: 0 } },
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		const next = applyEdgeRemoval(spec, "a", "b");
		expect(next.layout?.edges).toBeUndefined();
		expect(next.layout?.nodes).toEqual({ a: { x: 0, y: 0 } });
	});

	test("removal on an unknown edge returns same spec reference", () => {
		const spec = withEdges();
		expect(applyEdgeRemoval(spec, "ghost", "a")).toBe(spec);
		expect(applyEdgeRemoval(spec, "a", "b", "manual")).toBe(spec); // kind mismatch
	});

	test("removal on a spec with no layout edges is a no-op", () => {
		const spec = threeStepSpec();
		expect(applyEdgeRemoval(spec, "a", "b")).toBe(spec);
	});

	test("default kind matches `success` for an unkinded layout edge", () => {
		const spec: RoutineSpec = {
			...threeStepSpec(),
			layout: {
				version: 1,
				nodes: {},
				edges: [{ from: "a", to: "b" }],
			},
		};
		// Explicit kind omitted on the edge; removal w/ default "success" should match.
		const next = applyEdgeRemoval(spec, "a", "b");
		expect(next.layout?.edges).toBeUndefined();
	});
});
