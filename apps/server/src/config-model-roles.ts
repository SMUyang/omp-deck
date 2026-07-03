import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ModelInfo } from "@omp-deck/protocol";
import type { ModelRolesCapability } from "./bridge/types.ts";

export interface ConfigModelRolesStoreOptions {
	agentDir?: string;
	listModels: () => Promise<ModelInfo[]>;
}

interface OmpConfigDocument {
	modelRoles?: Record<string, unknown>;
	[key: string]: unknown;
}

export function createConfigModelRolesStore(options: ConfigModelRolesStoreOptions): ModelRolesCapability {
	const configPath = path.join(options.agentDir?.trim() || path.join(os.homedir(), ".omp", "agent"), "config.yml");

	return {
		async get() {
			const [config, models] = await Promise.all([readConfig(configPath), options.listModels()]);
			return { roles: normalizeRoles(config.modelRoles), models };
		},
		async patch(updates) {
			const config = await readConfig(configPath);
			const nextRoles = normalizeRoles(config.modelRoles);
			for (const [role, value] of Object.entries(updates.roles ?? {})) {
				if (value === null) delete nextRoles[role];
				else nextRoles[role] = value;
			}
			const models = await options.listModels();
			validateRoles(nextRoles, models);
			config.modelRoles = nextRoles;
			await writeConfig(configPath, config);
			return { roles: nextRoles, models };
		},
		async put(roles) {
			const config = await readConfig(configPath);
			const nextRoles = { ...roles };
			const models = await options.listModels();
			validateRoles(nextRoles, models);
			config.modelRoles = nextRoles;
			await writeConfig(configPath, config);
			return { roles: nextRoles, models };
		},
	};
}

async function readConfig(configPath: string): Promise<OmpConfigDocument> {
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = parseYaml(raw) as unknown;
		return isRecord(parsed) ? { ...parsed } : {};
	} catch (err) {
		if (isNodeErrno(err, "ENOENT")) return {};
		throw err;
	}
}

async function writeConfig(configPath: string, config: OmpConfigDocument): Promise<void> {
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, stringifyYaml(config), "utf-8");
}

function normalizeRoles(input: unknown): Record<string, string> {
	const roles: Record<string, string> = {};
	if (!isRecord(input)) return roles;
	for (const [role, value] of Object.entries(input)) {
		if (typeof value === "string") roles[role] = value;
	}
	return roles;
}

function validateRoles(roles: Record<string, string>, models: ModelInfo[]): void {
	for (const [role, value] of Object.entries(roles)) {
		if (!hasModel(value, models)) throw new Error(`unknown model for role ${role}: ${value}`);
	}
}

function hasModel(value: string, models: ModelInfo[]): boolean {
	const parsed = parseRoleModel(value);
	if (!parsed) return false;
	return models.some((model) => {
		if (model.provider !== parsed.provider) return false;
		return model.id === parsed.id || model.id === parsed.idWithoutThinking;
	});
}

function parseRoleModel(value: string): { provider: string; id: string; idWithoutThinking: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash);
	const id = value.slice(slash + 1);
	const suffix = id.lastIndexOf(":");
	const idWithoutThinking = suffix > 0 ? id.slice(0, suffix) : id;
	return { provider, id, idWithoutThinking };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrno(err: unknown, code: string): boolean {
	return isRecord(err) && err.code === code;
}
