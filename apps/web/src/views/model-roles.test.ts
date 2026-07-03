import { describe, expect, test } from "bun:test";

import type { ModelRef } from "@omp-deck/protocol";

import {
	buildPatchRequest,
	formatModelRef,
	isDynamicRole,
	parseModelRef,
	roleEntriesFromResponse,
} from "./model-roles";

// ── Inline API shapes matching the server routes-model-roles contract ────────
// Response: { roles: Record<string, string>, models: unknown[] }
// Role values are OMP-native "provider/modelId" strings.

interface ModelRolesResponse {
	roles: Record<string, string>;
	models: unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire serialization: provider/modelId
// Defends: the save format the server expects. A swapped order, missing slash,
// or wrong separator would corrupt every role assignment on save.
// ─────────────────────────────────────────────────────────────────────────────

describe("formatModelRef", () => {
	test("serializes { provider, id } as provider/modelId", () => {
		expect(formatModelRef({ provider: "zai", id: "glm-5.2" })).toBe("zai/glm-5.2");
		expect(formatModelRef({ provider: "anthropic", id: "claude-3-5-sonnet" })).toBe(
			"anthropic/claude-3-5-sonnet",
		);
	});
});

describe("parseModelRef", () => {
	test("deserializes provider/modelId into { provider, id }", () => {
		expect(parseModelRef("zai/glm-5.2")).toEqual({ provider: "zai", id: "glm-5.2" });
		expect(parseModelRef("anthropic/claude-3-5-sonnet")).toEqual({
			provider: "anthropic",
			id: "claude-3-5-sonnet",
		});
	});

	test("splits on the first slash so model ids may themselves contain slashes", () => {
		// Some providers/deployments use multi-segment ids; the provider is
		// everything before the first slash, the id is the remainder.
		expect(parseModelRef("openai/o1/preview")).toEqual({ provider: "openai", id: "o1/preview" });
	});

	test("round-trips with formatModelRef across boundary cases", () => {
		const refs: ModelRef[] = [
			{ provider: "zai", id: "glm-5.2" },
			{ provider: "anthropic", id: "claude-3-5-sonnet" },
			{ provider: "openai", id: "o1/preview" },
		];
		for (const ref of refs) {
			expect(parseModelRef(formatModelRef(ref))).toEqual(ref);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic vs built-in role classification
// Defends: the UI must not offer "delete" on built-in roles, and must group
// custom roles separately. advisor is the canonical custom role from OMP config.
// ─────────────────────────────────────────────────────────────────────────────

describe("isDynamicRole", () => {
	test("classifies custom roles such as advisor as dynamic", () => {
		expect(isDynamicRole("advisor")).toBe(true);
		expect(isDynamicRole("adviser")).toBe(true);
		expect(isDynamicRole("my-custom-role")).toBe(true);
	});

	test("classifies OMP built-in roles as not dynamic", () => {
		// Built-in set per pi-coding-agent model-registry: default, smol, slow,
		// vision, plan, designer, commit, task.
		expect(isDynamicRole("default")).toBe(false);
		expect(isDynamicRole("smol")).toBe(false);
		expect(isDynamicRole("task")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// API response → renderable role entries
// Defends: the section must surface every configured role — including custom
// dynamic roles like advisor — with parsed model refs and correct dynamic flags.
// ─────────────────────────────────────────────────────────────────────────────

describe("roleEntriesFromResponse", () => {
	test("parses each configured role into a structured entry with parsed model ref and dynamic flag", () => {
		const entries = roleEntriesFromResponse({
			roles: {
				advisor: "anthropic/claude-3-5-sonnet",
				default: "zai/glm-5.2",
			},
			models: [],
		} satisfies ModelRolesResponse);

		expect(entries).toContainEqual({
			name: "advisor",
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
			value: "anthropic/claude-3-5-sonnet",
			baseModelRef: "anthropic/claude-3-5-sonnet",
			thinking: undefined,
			dynamic: true,
		});
		expect(entries).toContainEqual({
			name: "default",
			model: { provider: "zai", id: "glm-5.2" },
			value: "zai/glm-5.2",
			baseModelRef: "zai/glm-5.2",
			thinking: undefined,
			dynamic: false,
		});
	});

	test("preserves thinking suffix in value and baseModelRef", () => {
		const entries = roleEntriesFromResponse({
			roles: { advisor: "zai/glm-5.2:xhigh" },
			models: [],
		} satisfies ModelRolesResponse);

		expect(entries[0]).toMatchObject({
			name: "advisor",
			value: "zai/glm-5.2:xhigh",
			baseModelRef: "zai/glm-5.2",
			thinking: "xhigh",
			model: { provider: "zai", id: "glm-5.2" },
		});
	});

	test("returns empty array for an empty roles map", () => {
		expect(roleEntriesFromResponse({ roles: {}, models: [] })).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Save request: PATCH body with provider/modelId format
// Defends: "saving via API with provider/modelId format." The PATCH body must
// serialize ModelRef selections into wire strings, preserve null for removals,
// and accept arbitrary new custom role names the user typed in.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPatchRequest", () => {
	test("formats selected model refs as provider/modelId wire strings", () => {
		const body = buildPatchRequest({
			advisor: { provider: "openai", id: "gpt-4o" },
			default: { provider: "zai", id: "glm-5.2" },
		});

		expect(body).toEqual({
			roles: {
				advisor: "openai/gpt-4o",
				default: "zai/glm-5.2",
			},
		});
	});

	test("preserves null values for role removal", () => {
		const body = buildPatchRequest({ "remove-me": null });

		expect(body.roles).toHaveProperty("remove-me", null);
	});

	test("accepts an arbitrary custom role name not present in the initial config", () => {
		const body = buildPatchRequest({
			"brand-new-advisor": { provider: "anthropic", id: "claude-3-5-sonnet" },
		});

		expect(body.roles).toHaveProperty("brand-new-advisor", "anthropic/claude-3-5-sonnet");
	});
});
