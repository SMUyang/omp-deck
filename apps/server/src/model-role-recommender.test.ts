import { describe, expect, test } from "bun:test";

import type { ModelInfo } from "@omp-deck/protocol";

import { recommendModelRoles } from "./model-role-recommender.ts";

function model(provider: string, id: string, available = true): ModelInfo {
	return { provider, id, label: id, isAvailable: available };
}

describe("recommendModelRoles (LMArena-driven)", () => {
	test("assigns highest arena score to default, then plan, then task", () => {
		const models = [
			model("haochi", "gpt-5.5"), // Elo 1525
			model("zai", "glm-5.2"), // Elo 1480
			model("opencode-go", "deepseek-v4-flash"), // Elo 1430
		];
		const r = recommendModelRoles(models);
		expect(r.recommended.default).toBe("haochi/gpt-5.5");
		expect(r.recommended.reviewer).toBe("haochi/gpt-5.5"); // same-role group shares top model
		expect(r.recommended.plan).toBe("zai/glm-5.2");
		expect(r.recommended.task).toBe("opencode-go/deepseek-v4-flash");
		// Reasons cite the arena leaderboard.
		expect(r.matched[0]?.reason).toContain("LMArena");
		expect(r.matched[0]?.reason).toContain("1525");
	});

	test("cheap workers take the lowest-scored available model", () => {
		const models = [
			model("haochi", "gpt-5.5"), // 1525 → default/reviewer/oracle
			model("zai", "glm-5.2"), // 1480 → plan
			model("opencode-go", "deepseek-v4-flash"), // 1430 → task
			model("opencode-go", "qwen3.7-plus"), // 1410 → explore
			model("opencode-go", "minimax-m3"), // not on snapshot (Elo 0) → smol (bottom)
		];
		const r = recommendModelRoles(models);
		expect(r.recommended.default).toBe("haochi/gpt-5.5");
		expect(r.recommended.plan).toBe("zai/glm-5.2");
		expect(r.recommended.smol).toBe("opencode-go/minimax-m3");
	});

	test("never recommends unavailable models", () => {
		const models = [
			model("haochi", "gpt-5.5", false),
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

	test("does not double the provider prefix when id already embeds it", () => {
		const models = [model("zai", "zai/glm-5.2")];
		const r = recommendModelRoles(models);
		expect(r.recommended.default).toBe("zai/glm-5.2");
		expect(r.recommended.default).not.toBe("zai/zai/glm-5.2");
	});

	test("single-model pool fills every role via duplicate bindings", () => {
		const r = recommendModelRoles([model("haochi", "gpt-5.5")]);
		// User policy: duplicate bindings are fine — a small pool reuses the
		// best available model rather than leaving roles unset.
		expect(r.recommended.default).toBe("haochi/gpt-5.5");
		expect(r.recommended.plan).toBe("haochi/gpt-5.5");
		expect(r.recommended.task).toBe("haochi/gpt-5.5");
		expect(r.recommended.smol).toBe("haochi/gpt-5.5");
	});

	test("unknown models still get assigned (sort last, no throw)", () => {
		const r = recommendModelRoles([model("foo", "bar")]);
		expect(r.recommended.default).toBe("foo/bar");
		expect(r.matched.length).toBeGreaterThan(0);
	});
});
