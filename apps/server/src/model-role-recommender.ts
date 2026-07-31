import type { ModelInfo } from "@omp-deck/protocol";

/**
 * Automatic model-role recommendation for OMP's modelRoles config.
 *
 * Picks the best available model from the effective pool per job type,
 * following the same split-pool strategy as the omp-model-pool-check skill:
 * heavy reasoning (default/reviewer/plan) on one pool, task execution on
 * another, cheap long-context models for smol/explore. Only models the
 * pool actually exposes (isAvailable) are recommended — never a stale id.
 */

export interface RoleRecommendation {
	/** role → "provider/model" selector */
	recommended: Record<string, string>;
	/** how each recommendation was made (provider/model matched) */
	matched: Array<{ role: string; selector: string; reason: string }>;
	/** roles left untouched (vision/designer/commit etc.) */
	preserved: string[];
}

interface RoleRule {
	roles: string[];
	/** provider prefix to prefer, or null for any */
	provider?: string;
	/** regex against the bare model id */
	match: RegExp;
	reason: string;
}

const RULES: RoleRule[] = [
	// Heavy reasoning split across pools (per omp-model-pool-check):
	{ roles: ["default", "reviewer", "oracle"], provider: "haochi", match: /gpt-5\.5/i, reason: "haochi GPT-5.5 — heavy reasoning / review" },
	{ roles: ["plan"], provider: "zai", match: /glm-5\.2/i, reason: "ZAI GLM-5.2 — planning, xhigh thinking" },
	{ roles: ["task"], provider: "opencode-go", match: /glm-5\.2/i, reason: "OpenCode Go GLM-5.2 — task execution" },
	// Cheap long-context workers:
	{ roles: ["smol", "quick_task"], match: /deepseek.*v4.*flash|v4-flash/i, reason: "OpenCode Go DeepSeek V4 Flash — mechanical/smol" },
	{ roles: ["explore", "librarian"], match: /qwen.*plus|qwen3\.7/i, reason: "OpenCode Go Qwen3.7 Plus — long-context exploration" },
];

/** Roles we leave alone unless the user explicitly asks to change them. */
const PRESERVE_ROLES = new Set(["vision", "designer", "commit"]);

export function recommendModelRoles(models: ModelInfo[]): RoleRecommendation {
	const available = models.filter((m) => m.isAvailable);
	const used = new Set<string>(); // selectors already claimed
	const recommended: Record<string, string> = {};
	const matched: RoleRecommendation["matched"] = [];
	const preserved: string[] = [];

	for (const rule of RULES) {
		let picked: ModelInfo | undefined;
		for (const m of available) {
			const bareId = m.id.replace(/^.*\//, ""); // strip provider prefix if embedded
			if (!rule.match.test(bareId)) continue;
			if (rule.provider && m.provider !== rule.provider) continue;
			const selector = modelSelector(m);
			if (used.has(selector)) continue;
			picked = m;
			break;
		}
		if (!picked) continue;
		const selector = modelSelector(picked);
		used.add(selector);
		for (const role of rule.roles) {
			recommended[role] = selector;
			matched.push({ role, selector, reason: rule.reason });
		}
	}

	return { recommended, matched, preserved: [...PRESERVE_ROLES] };
}

/**
 * Build a "provider/model" selector without doubling an embedded prefix:
 * some model pools return ids already prefixed (e.g. "zai/glm-5.2" with
 * provider "zai"); naive `${provider}/${id}` would yield "zai/zai/glm-5.2".
 */
function modelSelector(m: ModelInfo): string {
	return m.id.startsWith(`${m.provider}/`) ? m.id : `${m.provider}/${m.id}`;
}
