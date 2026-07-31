/**
 * Generic read/write for omp's config.yml (~/.omp/agent/config.yml).
 *
 *   GET   /api/settings/omp-config  — returns parsed config as JSON + path
 *   PATCH /api/settings/omp-config  — deep-merges updates into config.yml
 *
 * Security:
 *   - Sensitive values (apiKey, token, secret, password, ...) are redacted
 *     with "[redacted]" in the GET response — never sent to the browser.
 *   - PATCH treats "[redacted]" as "keep existing value", so saving the
 *     raw editor's full JSON back does NOT clobber secrets.
 *   - Dangerous prototype-pollution keys (__proto__, constructor,
 *     prototype) are rejected.
 */

import { Hono } from "hono";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";

type ConfigDoc = Record<string, unknown>;

const REDACTED = "[redacted]";

/** Keys whose string values are secrets and must never leave the server. */
const SENSITIVE_KEY_RE =
	/(token|secret|password|credential|bearer|api[_-]?key|client[_-]?secret|private[_-]?key)/i;

/** Prototype-pollution / dangerous keys rejected on write. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a PATCH updates object:
 *   - rejects dangerous keys anywhere in the tree (400)
 *   - for paths defined in OMP's SETTINGS_SCHEMA, validates leaf value types
 *     (boolean / number / string / enum / array / record)
 * Unknown paths are allowed for forward compatibility.
 * Throws Error with a message; caller maps to 400.
 */
function validateUpdates(updates: ConfigDoc): void {
	for (const [key, value] of Object.entries(updates)) {
		if (DANGEROUS_KEYS.has(key)) {
			throw new Error(`rejected dangerous key: ${key}`);
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			validateUpdates(value as ConfigDoc);
		}
	}
	for (const [dotPath, value] of flattenUpdates(updates)) {
		if (value === null || value === REDACTED) continue; // delete / keep-existing
		const def = SETTINGS_SCHEMA[dotPath as keyof typeof SETTINGS_SCHEMA];
		if (!def) continue; // unknown path — forward compatible
		validateLeafType(dotPath, value, def);
	}
}

function flattenUpdates(updates: ConfigDoc, prefix = ""): Array<[string, unknown]> {
	const out: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(updates)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			out.push(...flattenUpdates(value as ConfigDoc, path));
		} else {
			out.push([path, value]);
		}
	}
	return out;
}

function validateLeafType(path: string, value: unknown, def: { type?: string; values?: readonly string[] }): void {
	switch (def.type) {
		case "boolean":
			if (typeof value !== "boolean") throw new Error(`setting ${path} expects a boolean`);
			return;
		case "number":
			if (typeof value !== "number") throw new Error(`setting ${path} expects a number`);
			return;
		case "string":
			if (typeof value !== "string") throw new Error(`setting ${path} expects a string`);
			return;
		case "enum":
			if (typeof value !== "string" || !def.values?.includes(value)) {
				throw new Error(`setting ${path} expects one of: ${def.values?.join(", ")}`);
			}
			return;
		case "array":
			if (!Array.isArray(value)) throw new Error(`setting ${path} expects an array`);
			return;
		case "record":
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error(`setting ${path} expects an object`);
			}
			return;
		default:
			return; // unknown schema type — allow
	}
}

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

/**
 * Recursively replace secret string values with "[redacted]".
 * Non-string values under sensitive keys are left alone (booleans like
 * showTokenUsage, numbers, nested objects).
 */
function sanitizeConfig(value: unknown, key = ""): unknown {
	if (typeof value === "string" && value.length > 0 && SENSITIVE_KEY_RE.test(key)) {
		return REDACTED;
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeConfig(item, key));
	}
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = sanitizeConfig(v, k);
		}
		return out;
	}
	return value;
}

/**
 * Deep-merge `patch` into `target`. Nested objects merge; scalars overwrite.
 * - "[redacted]" patch values keep the existing target value (no clobber).
 * - null deletes the key.
 * - dangerous keys are skipped.
 */
function deepMerge(target: ConfigDoc, patch: ConfigDoc): ConfigDoc {
	const result = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (DANGEROUS_KEYS.has(key)) continue;
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
		} else if (value === REDACTED) {
			// Keep the existing secret — placeholder came from a redacted GET.
			continue;
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
			return c.json({ config: sanitizeConfig(config), path: configPath });
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
		// Reject dangerous keys and schema type mismatches before touching disk.
		try {
			validateUpdates(body.updates);
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}

		const configPath = resolveConfigPath();
		try {
			const current = await readConfig(configPath);
			const merged = deepMerge(current, body.updates);
			await writeConfig(configPath, merged);
			return c.json({ ok: true, config: sanitizeConfig(merged), path: configPath });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ error: `failed to write config.yml: ${msg}` }, 500);
		}
	});

	return app;
}
