import type { ModelRef } from "@omp-deck/protocol";

export interface ModelRolesResponse {
	roles: Record<string, string>;
	models: unknown[];
}

export interface ModelRoleEntry {
	name: string;
	model: ModelRef;
	/** Full OMP-native value including thinking suffix, e.g. "haochi/gpt-5.5:high". */
	value: string;
	/** Base model ref without thinking suffix, e.g. "haochi/gpt-5.5". */
	baseModelRef: string;
	/** Thinking level if present, e.g. "high", "low", "xhigh". */
	thinking?: string;
	dynamic: boolean;
}

export interface ModelRolesPatchRequest {
	roles: Record<string, string | null>;
}

const BUILT_IN_ROLES = new Set(["default", "smol", "slow", "vision", "plan", "designer", "commit", "task"]);

export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

export function parseModelRef(value: string): ModelRef {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return { provider: "", id: value };
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function stripThinkingSuffix(value: string): { base: string; thinking?: string } {
	const slash = value.indexOf("/");
	if (slash < 0) return { base: value };
	const idPart = value.slice(slash + 1);
	const colon = idPart.lastIndexOf(":");
	if (colon <= 0) return { base: value };
	return { base: value.slice(0, slash + 1 + colon), thinking: idPart.slice(colon + 1) };
}

export function isDynamicRole(role: string): boolean {
	return !BUILT_IN_ROLES.has(role);
}

export function roleEntriesFromResponse(response: ModelRolesResponse): ModelRoleEntry[] {
	return Object.entries(response.roles)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => {
			const { base, thinking } = stripThinkingSuffix(value);
			return {
				name,
				model: parseModelRef(base),
				value,
				baseModelRef: base,
				thinking,
				dynamic: isDynamicRole(name),
			};
		});
}

export function buildPatchRequest(updates: Record<string, ModelRef | null>): ModelRolesPatchRequest {
	const roles: Record<string, string | null> = {};
	for (const [role, value] of Object.entries(updates)) {
		roles[role] = value === null ? null : formatModelRef(value);
	}
	return { roles };
}
