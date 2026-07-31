import { describe, expect, test } from "bun:test";

import type { ModelInfo } from "@omp-deck/protocol";

import { recommendModelRoles } from "./model-role-recommender.ts";

function model(provider: string, id: string, available = true): ModelInfo {
	return { provider, id, label: id, isAvailable: available };
}

describe("recommendModelRoles", () => {
	test("maps heavy reasoning to haochi GPT-5.5, plan to ZAI GLM-5.2, task to opencode-go GLM-5.2", () => {
		const models = [
			model("haochi", "gpt-5.5"),
			model("zai", "glm-5.2"),
			model("opencode-go", "glm-5.2"),
			model("opencode-go", "deepseek-v4-flash"),
		];
		const r = recommendModelRoles(models);
		expect(r.recommended.default).toBe("haochi/gpt-5.5");
		expect(r.recommended.reviewer).toBe("haochi/gpt-5.5");
		expect(r.recommended.plan).toBe("zai/glm-5.2");
		expect(r.recommended.task).toBe("opencode-go/glm-5.2");
		expect(r.recommended.smol).toBe("opencode-go/deepseek-v4-flash");
		expect(r.matched.length).toBeGreaterThan(0);
	});

	test("never recommends unavailable models", () => {
		const models = [
			model("haochi", "gpt-5.5", false), // unavailable
			model("zai", "glm-5.2", false),
		];
		const r = recommendModelRoles(models);
		expect(Object.keys(r.recommended)).toHaveLength(0);
	});

	test("preserves vision/designer/commit by convention", () => {
		const r = recommendModelRoles([model("haochi", "gpt-5.5")]);
		expect(r.preserved).toContain("vision");
		expect(r.preserved).toContain("designer");
		expect(r.preserved).toContain("commit");
	});

	test("splits heavy reasoning and planning across pools (no single-model monopoly)", () => {
		const models = [model("haochi", "gpt-5.5"), model("opencode-go", "glm-5.2")];
		const r = recommendModelRoles(models);
		// Same-rule roles may share a selector (default/reviewer/oracle), but
		// different rules must not claim the same model.
		expect(r.recommended.default).toBe("haochi/gpt-5.5");
		expect(r.recommended.task).toBe("opencode-go/glm-5.2");
		expect(r.recommended.default).not.toBe(r.recommended.task);
		expect(r.recommended.smol).toBeUndefined(); // opencode-go glm-5.2 doesn't match smol rule
	});

	test("skips missing roles instead of failing", () => {
		// No pool matches any rule — empty recommendation, no throw.
		const r = recommendModelRoles([model("foo", "bar")]);
		expect(r.recommended).toEqual({});
		expect(r.matched).toEqual([]);
	});

	test("does not double the provider prefix when id already embeds it", () => {
		const models = [model("zai", "zai/glm-5.2")];
		const r = recommendModelRoles(models);
		expect(r.recommended.plan).toBe("zai/glm-5.2");
		expect(r.recommended.plan).not.toBe("zai/zai/glm-5.2");
	});
});
