import type {
	ListEnvSettingsResponse,
	PatchEnvSettingsRequest,
	PatchEnvSettingsResponse,
	RestartServerResponse,
	RevealEnvValueResponse,
} from "@omp-deck/protocol";
import type { ModelRolesPatchRequest, ModelRolesResponse } from "@/views/model-roles";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const settingsApi = {
	listEnv(): Promise<ListEnvSettingsResponse> {
		return req<ListEnvSettingsResponse>("/settings/env");
	},
	patchEnv(updates: PatchEnvSettingsRequest["updates"]): Promise<PatchEnvSettingsResponse> {
		return req<PatchEnvSettingsResponse>("/settings/env", {
			method: "PATCH",
			body: JSON.stringify({ updates } satisfies PatchEnvSettingsRequest),
		});
	},
	revealEnv(key: string): Promise<RevealEnvValueResponse> {
		return req<RevealEnvValueResponse>(`/settings/env/${encodeURIComponent(key)}?reveal=1`);
	},
	listModelRoles(): Promise<ModelRolesResponse> {
		return req<ModelRolesResponse>("/settings/model-roles");
	},
	patchModelRoles(updates: ModelRolesPatchRequest["roles"]): Promise<ModelRolesResponse> {
		return req<ModelRolesResponse>("/settings/model-roles", {
			method: "PATCH",
			body: JSON.stringify({ roles: updates } satisfies ModelRolesPatchRequest),
		});
	},
	restartServer(): Promise<RestartServerResponse> {
		return req<RestartServerResponse>("/server/restart", { method: "POST" });
	},
	getOmpConfig(): Promise<{ config: Record<string, unknown>; path: string }> {
		return req<{ config: Record<string, unknown>; path: string }>("/settings/omp-config");
	},
	getOmpSchema(): Promise<{
		tabs: Array<{
			id: string;
			label: string;
			settings: Array<{
				path: string;
				label: string;
				description?: string;
				type: string;
				values?: string[];
				default?: unknown;
			}>;
		}>;
	}> {
		return req("/settings/omp-schema");
	},
	patchOmpConfig(updates: Record<string, unknown>): Promise<{ ok: boolean; config: Record<string, unknown>; path: string }> {
		return req<{ ok: boolean; config: Record<string, unknown>; path: string }>("/settings/omp-config", {
			method: "PATCH",
			body: JSON.stringify({ updates }),
		});
	},
};
