/**
 * Round-trip tests for `stringifySpec` / `parseSpec`, focused on the V2
 * `layout` block introduced for the canvas builder.
 *
 *   1. A spec WITHOUT layout serializes without a `layout:` key (back-compat).
 *   2. A spec WITH layout serializes the block at the tail with stable order
 *      (version → nodes (sorted by id) → edges (authored order)).
 *   3. Round-trip is lossless: parse(stringify(spec)).spec deep-equals spec
 *      (modulo Ajv-accepted optional fields).
 *   4. Empty nodes / empty edges drop out of the emitted YAML.
 */

import { describe, expect, test } from "bun:test";

import type { RoutineSpec } from "@omp-deck/protocol";

import { parseSpec, replaceStep, stringifySpec } from "./spec-yaml";

const baseSpec: RoutineSpec = {
	name: "layout-roundtrip",
	trigger: [{ manual: {} }],
	steps: [
		{ id: "step_a", type: "wait", duration_secs: 1 },
		{ id: "step_b", type: "wait", duration_secs: 1 },
	],
};

describe("stringifySpec / parseSpec — layout round-trip", () => {
	test("spec without layout serializes WITHOUT a `layout:` key", () => {
		const yaml = stringifySpec(baseSpec);
		expect(yaml).not.toContain("layout:");
	});

	test("spec with layout serializes the block at the tail in stable order", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				// Insertion order is intentionally NOT alphabetical to verify sort.
				nodes: {
					step_b: { x: 280, y: 220 },
					step_a: { x: 280, y: 0 },
				},
				edges: [{ from: "step_a", to: "step_b", kind: "success" }],
			},
		};
		const yaml = stringifySpec(spec);
		// `steps:` must appear before `layout:`.
		expect(yaml.indexOf("steps:")).toBeLessThan(yaml.indexOf("layout:"));
		// node keys appear alphabetically.
		expect(yaml.indexOf("step_a:")).toBeLessThan(yaml.indexOf("step_b:"));
		// version, nodes, edges all serialize.
		expect(yaml).toContain("version: 1");
		expect(yaml).toContain("nodes:");
		expect(yaml).toContain("edges:");
	});

	test("round-trip is lossless for a fully-populated layout", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: {
					step_a: { x: 280, y: 0 },
					step_b: { x: 280, y: 220, collapsed: true },
				},
				edges: [
					{ from: "step_a", to: "step_b", kind: "success" },
					{ from: "step_a", to: "step_b", kind: "manual", label: "fallback" },
				],
			},
		};
		const yaml = stringifySpec(spec);
		const result = parseSpec(yaml);
		expect(result.ok).toBe(true);
		expect(result.spec?.layout?.version).toBe(1);
		expect(result.spec?.layout?.nodes?.step_a).toEqual({ x: 280, y: 0 });
		expect(result.spec?.layout?.nodes?.step_b).toEqual({
			x: 280,
			y: 220,
			collapsed: true,
		});
		expect(result.spec?.layout?.edges).toEqual([
			{ from: "step_a", to: "step_b", kind: "success" },
			{ from: "step_a", to: "step_b", kind: "manual", label: "fallback" },
		]);
	});

	test("empty nodes / edges drop out of the emitted YAML", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: { version: 1, nodes: {}, edges: [] },
		};
		const yaml = stringifySpec(spec);
		expect(yaml).toContain("version: 1");
		expect(yaml).not.toContain("nodes:");
		expect(yaml).not.toContain("edges:");
	});
});

describe("replaceStep — id rename cascade", () => {
	test("no rename: returns spec untouched aside from steps array", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: { step_a: { x: 100, y: 0 }, step_b: { x: 100, y: 220 } },
			},
		};
		const next = replaceStep(spec, 0, { id: "step_a", type: "wait", duration_secs: 5 });
		// layout block carried through verbatim.
		expect(next.layout).toEqual(spec.layout);
		// only the patched step changed.
		expect((next.steps[0] as { duration_secs: number }).duration_secs).toBe(5);
	});

	test("rename: migrates the layout.nodes key, preserving collapsed flag", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: {
					step_a: { x: 100, y: 0, collapsed: true },
					step_b: { x: 100, y: 220 },
				},
			},
		};
		const next = replaceStep(spec, 0, {
			id: "renamed_a",
			type: "wait",
			duration_secs: 1,
		});
		expect(next.layout?.nodes?.renamed_a).toEqual({ x: 100, y: 0, collapsed: true });
		expect(next.layout?.nodes?.step_a).toBeUndefined();
		// Unrelated node untouched.
		expect(next.layout?.nodes?.step_b).toEqual({ x: 100, y: 220 });
	});

	test("rename: rewrites layout.edges endpoints (from + to)", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: { step_a: { x: 0, y: 0 }, step_b: { x: 0, y: 220 } },
				edges: [
					{ from: "step_a", to: "step_b", kind: "success" },
					{ from: "step_b", to: "step_a", kind: "manual" },
				],
			},
		};
		const next = replaceStep(spec, 0, {
			id: "renamed_a",
			type: "wait",
			duration_secs: 1,
		});
		expect(next.layout?.edges).toEqual([
			{ from: "renamed_a", to: "step_b", kind: "success" },
			{ from: "step_b", to: "renamed_a", kind: "manual" },
		]);
	});

	test("rename on a spec with NO layout returns spec without inventing one", () => {
		const next = replaceStep(baseSpec, 0, {
			id: "renamed_a",
			type: "wait",
			duration_secs: 1,
		});
		expect(next.layout).toBeUndefined();
		expect(next.steps[0]?.id).toBe("renamed_a");
	});
});
