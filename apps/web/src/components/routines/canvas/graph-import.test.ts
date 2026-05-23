/**
 * Unit tests for `importFromSpec`. Covers:
 *   1. Routine without `layout` → vertical fallback positions + sequential edges.
 *   2. `when:` cross-step references produce dashed inferred dependency edges.
 *   3. Explicit `spec.layout` round-trips: positions + edges are honored verbatim,
 *      and `layout.nodes` partial coverage still produces nodes for every step.
 */

import { describe, expect, test } from "bun:test";

import type { RoutineSpec } from "@omp-deck/protocol";

import {
	CANVAS_DEFAULT_X,
	CANVAS_NODE_VERTICAL_GAP,
} from "./graph-types";
import { importFromSpec } from "./graph-import";

const baseTrigger: RoutineSpec["trigger"] = [{ manual: {} }];

describe("importFromSpec — no layout", () => {
	test("places steps vertically and synthesizes sequential edges", () => {
		const spec: RoutineSpec = {
			name: "linear",
			trigger: baseTrigger,
			steps: [
				{ id: "a", type: "wait", duration_secs: 1 },
				{ id: "b", type: "wait", duration_secs: 1 },
				{ id: "c", type: "wait", duration_secs: 1 },
			],
		};
		const { nodes, edges } = importFromSpec(spec);
		expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
		expect(nodes.map((n) => n.position)).toEqual([
			{ x: CANVAS_DEFAULT_X, y: 0 },
			{ x: CANVAS_DEFAULT_X, y: CANVAS_NODE_VERTICAL_GAP },
			{ x: CANVAS_DEFAULT_X, y: CANVAS_NODE_VERTICAL_GAP * 2 },
		]);
		expect(nodes.every((n) => n.data.inferredPosition)).toBe(true);
		expect(edges.map((e) => [e.source, e.target])).toEqual([
			["a", "b"],
			["b", "c"],
		]);
		expect(edges.every((e) => e.data?.inferred)).toBe(true);
	});

	test("adds dashed dependency edge when a step's `when:` references a non-prev step", () => {
		const spec: RoutineSpec = {
			name: "with-when",
			trigger: baseTrigger,
			steps: [
				{ id: "should_run", type: "transform", body: "return true;" },
				{ id: "middle", type: "wait", duration_secs: 1 },
				{
					id: "branch",
					type: "wait",
					duration_secs: 1,
					when: "steps.should_run.json === true",
				},
			],
		};
		const { edges } = importFromSpec(spec);
		const sequentialPairs = edges
			.filter((e) => e.data?.kind === "success")
			.map((e) => [e.source, e.target]);
		const manualPairs = edges
			.filter((e) => e.data?.kind === "manual")
			.map((e) => [e.source, e.target]);
		expect(sequentialPairs).toContainEqual(["should_run", "middle"]);
		expect(sequentialPairs).toContainEqual(["middle", "branch"]);
		expect(manualPairs).toContainEqual(["should_run", "branch"]);
		// Manual edges are inferred and dashed.
		const manualEdge = edges.find((e) => e.data?.kind === "manual");
		expect(manualEdge?.data?.inferred).toBe(true);
	});

	test("does not duplicate the dependency edge when `when:` references the immediately-previous step", () => {
		const spec: RoutineSpec = {
			name: "adjacent-when",
			trigger: baseTrigger,
			steps: [
				{ id: "pre", type: "transform", body: "return 1;" },
				{
					id: "next",
					type: "wait",
					duration_secs: 1,
					when: "steps.pre.json > 0",
				},
			],
		};
		const { edges } = importFromSpec(spec);
		// Exactly one sequential edge; no extra manual.
		expect(edges).toHaveLength(1);
		expect(edges[0]?.data?.kind).toBe("success");
	});
});

describe("importFromSpec — explicit layout", () => {
	test("honors saved node positions and edges verbatim", () => {
		const spec: RoutineSpec = {
			name: "saved",
			trigger: baseTrigger,
			steps: [
				{ id: "a", type: "wait", duration_secs: 1 },
				{ id: "b", type: "wait", duration_secs: 1 },
			],
			layout: {
				version: 1,
				nodes: {
					a: { x: 100, y: 50 },
					b: { x: 100, y: 300 },
				},
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		const { nodes, edges } = importFromSpec(spec);
		expect(nodes.find((n) => n.id === "a")?.position).toEqual({ x: 100, y: 50 });
		expect(nodes.find((n) => n.id === "b")?.position).toEqual({ x: 100, y: 300 });
		expect(nodes.every((n) => !n.data.inferredPosition)).toBe(true);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.data?.inferred).toBe(false);
		expect(edges[0]?.source).toBe("a");
		expect(edges[0]?.target).toBe("b");
	});

	test("steps without a saved layout entry still render at a fallback position", () => {
		const spec: RoutineSpec = {
			name: "partial-layout",
			trigger: baseTrigger,
			steps: [
				{ id: "a", type: "wait", duration_secs: 1 },
				{ id: "b", type: "wait", duration_secs: 1 },
			],
			layout: {
				version: 1,
				nodes: { a: { x: 50, y: 50 } },
				edges: [],
			},
		};
		const { nodes } = importFromSpec(spec);
		const a = nodes.find((n) => n.id === "a");
		const b = nodes.find((n) => n.id === "b");
		expect(a?.position).toEqual({ x: 50, y: 50 });
		expect(a?.data.inferredPosition).toBe(false);
		expect(b?.position).toEqual({
			x: CANVAS_DEFAULT_X,
			y: CANVAS_NODE_VERTICAL_GAP,
		});
		expect(b?.data.inferredPosition).toBe(true);
	});

	test("drops layout edges referencing missing step ids", () => {
		const spec: RoutineSpec = {
			name: "stale-edge",
			trigger: baseTrigger,
			steps: [{ id: "a", type: "wait", duration_secs: 1 }],
			layout: {
				version: 1,
				edges: [{ from: "a", to: "deleted" }],
			},
		};
		const { edges } = importFromSpec(spec);
		expect(edges).toEqual([]);
	});
});
