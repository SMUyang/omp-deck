/**
 * Generic read/write for omp's config.yml (~/.omp/agent/config.yml).
 *
 *   GET   /api/settings/omp-config  — returns parsed config as JSON + path
 *   PATCH /api/settings/omp-config  — deep-merges updates into config.yml
 *
 * Uses the same read-modify-write pattern as config-model-roles.ts,
 * preserving unrelated keys.
 */

import { Hono } from "hono";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type ConfigDoc = Record<string, unknown>;

function resolveConfigPath(): string {
	const agentDir = process.env.OMP_AGENT_DIR?.trim();
	return path.join(agentDir || path.join(os.homedir(), ".omp", "agent"), "config.yml");
}

async function readConfig(configPath: string): Promise<ConfigDoc> {
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = parseYaml(raw) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? { ...parsed }
			: {};
	} catch (err) {
		if (isNodeErrno(err, "ENOENT")) return {};
		throw err;
	}
}

async function writeConfig(configPath: string, config: ConfigDoc): Promise<void> {
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, stringifyYaml(config), "utf-8");
}

/** Deep-merge `patch` into `target`. Nested objects merge; scalars overwrite. */
function deepMerge(target: ConfigDoc, patch: ConfigDoc): ConfigDoc {
	const result = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key];
		} else if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			typeof result[key] === "object" &&
			result[key] !== null &&
			!Array.isArray(result[key])
		) {
			result[key] = deepMerge(result[key] as ConfigDoc, value as ConfigDoc);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function isNodeErrno(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as Record<string, unknown>).code === code;
}

export function buildOmpConfigRouter(): Hono {
	const app = new Hono();

	app.get("/settings/omp-config", async (c) => {
		const configPath = resolveConfigPath();
		try {
			const config = await readConfig(configPath);
			return c.json({ config, path: configPath });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ error: `failed to read config.yml: ${msg}` }, 500);
		}
	});

	app.patch("/settings/omp-config", async (c) => {
		let body: { updates?: ConfigDoc };
		try {
			body = (await c.req.json()) as { updates?: ConfigDoc };
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.updates || typeof body.updates !== "object") {
			return c.json({ error: "updates must be an object" }, 400);
		}

		const configPath = resolveConfigPath();
		try {
			const current = await readConfig(configPath);
			const merged = deepMerge(current, body.updates);
			await writeConfig(configPath, merged);
			return c.json({ ok: true, config: merged, path: configPath });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ error: `failed to write config.yml: ${msg}` }, 500);
		}
	});

	return app;
}
