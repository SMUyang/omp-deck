import type { ModelInfo } from "@omp-deck/protocol";

/**
 * Automatic model-role recommendation driven by the LMArena leaderboard.
 *
 * Every model in the effective pool is scored against the arena leaderboard
 * snapshot (arena.ai, 2026-07). Heavy reasoning roles (default/reviewer/
 * oracle/plan) take the highest-scoring available models, medium roles
 * (task/explore/librarian) take the middle, and cheap worker roles
 * (smol/quick_task) take the lowest — so the strongest models do the hard
 * thinking and cheap models do the mechanical work. Only models the pool
 * actually exposes (isAvailable) are recommended — never a stale id.
 */

export interface RoleRecommendation {
	/** role → "provider/model" selector */
	recommended: Record<string, string>;
	/** how each recommendation was made (arena Elo) */
	matched: Array<{ role: string; selector: string; reason: string }>;
	/** roles left untouched (vision/designer/commit etc.) */
	preserved: string[];
}

/** Roles we leave alone unless the user explicitly asks to change them. */
const PRESERVE_ROLES = new Set(["vision", "designer", "commit"]);

/** Allocation groups: each group takes ONE model, shared by all its roles. */
const GROUPS: Array<{ roles: string[]; from: "top" | "bottom" }> = [
	{ roles: ["default", "reviewer", "oracle"], from: "top" }, // highest arena score
	{ roles: ["plan"], from: "top" },
	{ roles: ["task"], from: "top" },
	{ roles: ["explore", "librarian"], from: "top" },
	{ roles: ["smol", "quick_task"], from: "bottom" }, // cheapest workers
];

interface ArenaEntry {
	/** regex against the bare model id (provider prefix stripped) */
	match: RegExp;
	/** arena leaderboard Elo / win-rate score; higher = better */
	elo: number;
	/** display name used in the reason string */
	label: string;
}

/**
 * LMArena leaderboard snapshot (arena.ai, 2026-07). Ranked by arena score.
 * Extend as the leaderboard moves. Models absent here score 0 and sort last.
 */
const ARENA_RANKING: ArenaEntry[] = [
	{ match: /claude.*fable.*5|fable-5/i, elo: 1565, label: "Claude Fable 5" },
	{ match: /claude.*opus.*5|opus-5/i, elo: 1555, label: "Claude Opus 5" },
	{ match: /gpt-5\.6|gpt.*5\.6/i, elo: 1540, label: "GPT-5.6" },
	{ match: /gpt-5\.5/i, elo: 1525, label: "GPT-5.5" },
	{ match: /claude.*sonnet.*4-?\.?6|sonnet-4-?\.?6/i, elo: 1505, label: "Claude Sonnet 4.6" },
	{ match: /gemini.*3\.1|gemini-3-?\.?1/i, elo: 1500, label: "Gemini 3.1" },
	{ match: /kimi.*k2\.7|k2-?\.?7/i, elo: 1490, label: "Kimi K2.7" },
	{ match: /glm-5\.2|glm.*5\.2/i, elo: 1480, label: "GLM-5.2" },
	{ match: /gpt-5\.4/i, elo: 1470, label: "GPT-5.4" },
	{ match: /deepseek.*v4/i, elo: 1430, label: "DeepSeek V4" },
	{ match: /qwen.*3\.7|qwen3-?\.?7/i, elo: 1410, label: "Qwen3.7" },
];

export function recommendModelRoles(models: ModelInfo[]): RoleRecommendation {
	const scored = models
		.filter((m) => m.isAvailable)
		.map((m) => {
			const bareId = m.id.replace(/^.*\//, "");
			const entry = ARENA_RANKING.find((e) => e.match.test(bareId));
			return { m, elo: entry?.elo ?? 0, label: entry?.label ?? bareId };
		})
		.sort((a, b) => b.elo - a.elo); // highest arena score first

	const used = new Set<string>();
	const recommended: Record<string, string> = {};
	const matched: RoleRecommendation["matched"] = [];
	const preserved = [...PRESERVE_ROLES];

	const take = (from: "top" | "bottom", roles: readonly string[]): void => {
		const pool = from === "top" ? scored : [...scored].reverse();
		// Prefer a not-yet-claimed model; if every model is already bound,
		// reuse the best-fit one for this group — duplicate bindings are fine
		// (a strong pool may only expose one or two usable models).
		const pick = pool.find((s) => !used.has(modelSelector(s.m))) ?? pool[0];
		if (!pick) return;
		const selector = modelSelector(pick.m);
		used.add(selector);
		for (const role of roles) {
			recommended[role] = selector;
			matched.push({
				role,
				selector,
				reason: `LMArena ${pick.label} (Elo ${pick.elo})${from === "bottom" ? " — cheap worker" : ""}`,
			});
		}
	};

	for (const group of GROUPS) take(group.from, group.roles);

	return { recommended, matched, preserved };
}

/**
 * Build a "provider/model" selector without doubling an embedded prefix:
 * some model pools return ids already prefixed (e.g. "zai/glm-5.2" with
 * provider "zai"); naive `${provider}/${id}` would yield "zai/zai/glm-5.2".
 */
function modelSelector(m: ModelInfo): string {
	return m.id.startsWith(`${m.provider}/`) ? m.id : `${m.provider}/${m.id}`;
}
