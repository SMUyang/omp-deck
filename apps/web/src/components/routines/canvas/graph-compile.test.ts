/**
 * Unit tests for `compileGraph`. Covers:
 *
 *   1. Linear short-circuit (no `layout.edges`) returns identity, no errors.
 *   2. Explicit edges produce a topo-sorted order that matches the graph.
 *   3. Branch + merge (diamond) compiles to a valid order.
 *   4. Cycle (A→B→A) blocks save with a cycle error naming both nodes.
 *   5. Dangling edge (target missing from `spec.steps`) yields a missing-target
 *      error.
 *   6. Self-loop (A→A) yields a self-loop error and the loop is dropped from
 *      the adjacency so it does not also trip cycle detection.
 *   7. Duplicate step ids surface as duplicate-id errors.
 *   8. Stable tie-breaking: when multiple nodes are ready simultaneously, the
 *      compile honors original `spec.steps` index order.
 *   9. Topo respects an explicit reverse edge (B→A wired by user) — the
 *      compiled order swaps relative to the authored array order.
 */

import { describe, expect, test } from "bun:test";

import type { RoutineSpec, RoutineStep } from "@omp-deck/protocol";

import { compileGraph } from "./graph-compile";
import { applyAddNodeAtBottom } from "./graph-add";
import { applyEdgeConnection } from "./graph-connect";
import { scaffoldStep } from "../spec-yaml";

const baseTrigger: RoutineSpec["trigger"] = [{ manual: {} }];

function wait(id: string): RoutineStep {
	return { id, type: "wait", duration_secs: 1 };
}

function specWith(steps: RoutineStep[], edges?: Array<{ from: string; to: string }>): RoutineSpec {
	return {
		name: "test",
		trigger: baseTrigger,
		steps,
		...(edges
			? {
				layout: {
					version: 1,
					edges: edges.map((e) => ({ from: e.from, to: e.to, kind: "success" as const })),
				},
			}
			: {}),
	};
}

describe("compileGraph — linear short-circuit", () => {
	test("no layout → identity, no errors", () => {
		const spec = specWith([wait("a"), wait("b"), wait("c")]);
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		expect(steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	test("empty `layout.edges` is the same as missing layout", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [wait("a"), wait("b")],
			layout: { version: 1, edges: [] },
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
	});
});

describe("compileGraph — explicit edges", () => {
	test("linear chain compiles to the wired order", () => {
		const spec = specWith(
			[wait("a"), wait("b"), wait("c")],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			],
		);
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		expect(steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
	});

	test("user-wired reverse edge swaps the array order on save", () => {
		// Authored as [a, b] but the user explicitly wired b→a, expecting b first.
		const spec = specWith([wait("a"), wait("b")], [{ from: "b", to: "a" }]);
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		expect(steps.map((s) => s.id)).toEqual(["b", "a"]);
	});

	test("diamond (branch + merge) produces a valid topo order", () => {
		// a fans into b and c, both feed into d.
		const spec = specWith(
			[wait("a"), wait("b"), wait("c"), wait("d")],
			[
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
				{ from: "b", to: "d" },
				{ from: "c", to: "d" },
			],
		);
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const ids = steps.map((s) => s.id);
		// a must precede both b and c; both must precede d.
		expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
		expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
		expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
		expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
		// With stable tie-break on original index, ordering is deterministic.
		expect(ids).toEqual(["a", "b", "c", "d"]);
	});

	test("multi-edge between same pair collapses to one in-degree contribution", () => {
		// Two edges a→b shouldn't make b appear "doubly blocked"; topo still resolves.
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [wait("a"), wait("b")],
			layout: {
				version: 1,
				edges: [
					{ from: "a", to: "b", kind: "success" },
					{ from: "a", to: "b", kind: "manual" },
				],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
	});
});

describe("compileGraph — stable tie-breaking", () => {
	test("two independent roots resolve in original-array order", () => {
		// Both `a` and `c` are roots (in-degree 0). Authored order: a, b, c, d.
		const spec = specWith(
			[wait("a"), wait("b"), wait("c"), wait("d")],
			[
				{ from: "a", to: "b" },
				{ from: "c", to: "d" },
			],
		);
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		// Tie-break by original index: a < c, and b < d, so [a,c,b,d] is wrong;
		// the implementation pops the lowest index from `ready` each step, so
		// after a's emission b becomes ready (index 1), then c (index 2) is
		// still ready from the initial set. Expected: [a, b, c, d].
		expect(steps.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
	});
});

describe("compileGraph — errors", () => {
	test("cycle A→B→A is reported with both nodes", () => {
		const spec = specWith(
			[wait("a"), wait("b")],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "a" },
			],
		);
		const { errors } = compileGraph(spec);
		expect(errors).toHaveLength(1);
		const err = errors[0]!;
		expect(err.code).toBe("cycle");
		expect(err.nodeIds.sort()).toEqual(["a", "b"]);
		expect(err.message).toContain("Cycle");
	});

	test("longer cycle A→B→C→A lists all three members", () => {
		const spec = specWith(
			[wait("a"), wait("b"), wait("c")],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
				{ from: "c", to: "a" },
			],
		);
		const { errors } = compileGraph(spec);
		const cycle = errors.find((e) => e.code === "cycle");
		expect(cycle).toBeDefined();
		expect(cycle!.nodeIds.sort()).toEqual(["a", "b", "c"]);
	});

	test("dangling target → missing-target error naming the orphan id", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [wait("a")],
			layout: {
				version: 1,
				edges: [{ from: "a", to: "ghost", kind: "success" }],
			},
		};
		const { errors } = compileGraph(spec);
		const missing = errors.find((e) => e.code === "missing-target");
		expect(missing).toBeDefined();
		expect(missing!.nodeIds).toEqual(["ghost"]);
		expect(missing!.message).toContain("ghost");
	});

	test("self-loop A→A is its own error code, NOT cycle", () => {
		const spec = specWith([wait("a"), wait("b")], [
			{ from: "a", to: "a" },
			{ from: "a", to: "b" },
		]);
		const { steps, errors } = compileGraph(spec);
		const selfLoop = errors.find((e) => e.code === "self-loop");
		expect(selfLoop).toBeDefined();
		expect(selfLoop!.nodeIds).toEqual(["a"]);
		// Self-loop is dropped from adjacency so cycle detection does not also fire.
		expect(errors.find((e) => e.code === "cycle")).toBeUndefined();
		// And the rest of the graph still topo-sorts (a → b is honored).
		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("duplicate step ids surface as duplicate-id errors", () => {
		// Hand-constructed; the schema would normally reject this on full validation.
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [wait("a"), wait("a"), wait("b")],
			layout: { version: 1, edges: [{ from: "a", to: "b", kind: "success" }] },
		};
		const { errors } = compileGraph(spec);
		const dup = errors.find((e) => e.code === "duplicate-id");
		expect(dup).toBeDefined();
		expect(dup!.nodeIds).toEqual(["a"]);
		expect(dup!.message).toContain("2×");
	});
});

describe("compileGraph — return shape on errors", () => {
	test("cycle returns original step order (best-effort, not topo)", () => {
		const spec = specWith(
			[wait("a"), wait("b")],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "a" },
			],
		);
		const { steps } = compileGraph(spec);
		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
	});

	test("missing-target does NOT block topo of the valid subgraph", () => {
		// b → ghost is dangling, but a → b is still wireable.
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [wait("a"), wait("b")],
			layout: {
				version: 1,
				edges: [
					{ from: "a", to: "b", kind: "success" },
					{ from: "b", to: "ghost", kind: "success" },
				],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors.find((e) => e.code === "missing-target")).toBeDefined();
		// Compile still emits a topo order over the known nodes.
		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
	});
});

describe("compileGraph — branch (`true`/`false`) edge compilation", () => {
	test("single `true` edge compiles to `when: steps.X.json === true` on the target", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [
				{ id: "gate", type: "transform", body: "return true;" },
				{ id: "act", type: "wait", duration_secs: 1 },
			],
			layout: {
				version: 1,
				edges: [{ from: "gate", to: "act", kind: "true" }],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const act = steps.find((s) => s.id === "act")!;
		expect(act.when).toBe("steps.gate.json === true");
	});

	test("single `false` edge compiles to `=== false` on the target", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [
				{ id: "gate", type: "transform", body: "return false;" },
				{ id: "fallback", type: "wait", duration_secs: 1 },
			],
			layout: {
				version: 1,
				edges: [{ from: "gate", to: "fallback", kind: "false" }],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const fallback = steps.find((s) => s.id === "fallback")!;
		expect(fallback.when).toBe("steps.gate.json === false");
	});

	test("existing `when:` on the target is preserved and AND-merged", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [
				{ id: "should_send", type: "transform", body: "return true;" },
				{
					id: "agent_send",
					type: "wait",
					duration_secs: 1,
					when: "state.enabled !== false",
				},
			],
			layout: {
				version: 1,
				edges: [{ from: "should_send", to: "agent_send", kind: "true" }],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const target = steps.find((s) => s.id === "agent_send")!;
		expect(target.when).toBe("(state.enabled !== false) && (steps.should_send.json === true)");
	});

	test("two branch edges into the same target AND-merge together", () => {
		// Contrived: `target` is gated on BOTH gateA being true AND gateB being false.
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [
				{ id: "gateA", type: "transform", body: "return true;" },
				{ id: "gateB", type: "transform", body: "return false;" },
				{ id: "target", type: "wait", duration_secs: 1 },
			],
			layout: {
				version: 1,
				edges: [
					{ from: "gateA", to: "target", kind: "true" },
					{ from: "gateB", to: "target", kind: "false" },
				],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const target = steps.find((s) => s.id === "target")!;
		// Branch clauses appear in edge-array order, each wrapped in parens.
		expect(target.when).toBe("(steps.gateA.json === true) && (steps.gateB.json === false)");
	});

	test("non-branch edges (`success`, `manual`) do not contribute to `when:`", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [wait("a"), wait("b")],
			layout: {
				version: 1,
				edges: [{ from: "a", to: "b", kind: "success" }],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const b = steps.find((s) => s.id === "b")!;
		expect(b.when).toBeUndefined();
	});

	test("branch + success edge into same target: only branch contributes to when:, but topo still orders both deps before target", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [
				{ id: "gate", type: "transform", body: "return true;" },
				wait("setup"),
				wait("target"),
			],
			layout: {
				version: 1,
				edges: [
					{ from: "gate", to: "target", kind: "true" },
					{ from: "setup", to: "target", kind: "success" },
				],
			},
		};
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const target = steps.find((s) => s.id === "target")!;
		expect(target.when).toBe("steps.gate.json === true");
		// Topo: both `gate` and `setup` must come before `target`.
		const ids = steps.map((s) => s.id);
		expect(ids.indexOf("gate")).toBeLessThan(ids.indexOf("target"));
		expect(ids.indexOf("setup")).toBeLessThan(ids.indexOf("target"));
	});

	test("compiled when: does not mutate the original spec.steps", () => {
		const spec: RoutineSpec = {
			name: "test",
			trigger: baseTrigger,
			steps: [
				{ id: "gate", type: "transform", body: "return true;" },
				{ id: "act", type: "wait", duration_secs: 1 },
			],
			layout: {
				version: 1,
				edges: [{ from: "gate", to: "act", kind: "true" }],
			},
		};
		const { steps } = compileGraph(spec);
		// Compiled `act` carries the gate; the original spec.steps[1] does not.
		expect(steps.find((s) => s.id === "act")!.when).toBe("steps.gate.json === true");
		expect(spec.steps[1]!.when).toBeUndefined();
	});
});


describe("if-node end-to-end (scaffold → wire → compile)", () => {
	test("scaffolded `if` step is a transform with a boolean placeholder body", () => {
		const step = scaffoldStep("transform", [], undefined, "if");
		expect(step.type).toBe("transform");
		expect(step.id).toBe("if");
		const body = (step as Extract<RoutineStep, { type: "transform" }>).body;
		expect(body).toMatch(/return\s+true/);
	});

	test("scaffold + wire two branches + compile produces gated downstream steps", () => {
		// Realistic canvas flow: start empty, drop the if-node first, then add
		// the two branch consumers, then wire from the if-node's labeled
		// handles. Array order ends up [if, act_true, act_false] so the
		// inferred sequentials lifted on first explicit edge are forward (no
		// cycle introduced by lifting).
		let spec: RoutineSpec = { name: "test", trigger: baseTrigger, steps: [] };
		const ifStep = scaffoldStep("transform", [], undefined, "if");
		spec = applyAddNodeAtBottom(spec, ifStep);
		spec = applyAddNodeAtBottom(spec, { id: "act_true", type: "wait", duration_secs: 1 });
		spec = applyAddNodeAtBottom(spec, { id: "act_false", type: "wait", duration_secs: 1 });
		spec = applyEdgeConnection(spec, ifStep.id, "act_true", "true");
		spec = applyEdgeConnection(spec, ifStep.id, "act_false", "false");
		const { steps, errors } = compileGraph(spec);
		expect(errors).toEqual([]);
		const actTrue = steps.find((s) => s.id === "act_true")!;
		const actFalse = steps.find((s) => s.id === "act_false")!;
		expect(actTrue.when).toBe(`steps.${ifStep.id}.json === true`);
		expect(actFalse.when).toBe(`steps.${ifStep.id}.json === false`);
		// The if-node runs before both branches.
		const ids = steps.map((s) => s.id);
		expect(ids.indexOf(ifStep.id)).toBeLessThan(ids.indexOf("act_true"));
		expect(ids.indexOf(ifStep.id)).toBeLessThan(ids.indexOf("act_false"));
	});
});
