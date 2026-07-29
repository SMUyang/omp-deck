/**
 * Atomic read/write of `~/.omp/agent/models.yml` — the canonical source omp
 * reads to discover custom OpenAI-compatible providers.
 *
 * Read order: (1) yml exists → use it; (2) yml missing but legacy json exists
 * → parse json as a starting doc; (3) both missing → empty.
 *
 * `providers` field, if present, MUST be a mapping — anything else throws to
 * avoid silently destroying user config. All writes preserve unknown keys.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Valid `api` values from omp's ProviderConfigSchema (models-config-schema.ts). */
const SUPPORTED_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
] as const;
export type ProviderApi = (typeof SUPPORTED_PROVIDER_APIS)[number];

const SUPPORTED_AUTH = ["apiKey", "none", "oauth"] as const;
export type ProviderAuth = (typeof SUPPORTED_AUTH)[number];

export { SUPPORTED_PROVIDER_APIS, SUPPORTED_AUTH };

export interface CustomModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface CustomProvider {
	baseUrl: string;
	api: ProviderApi;
	apiKey?: string;
	auth?: ProviderAuth;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
	};
	models: CustomModel[];
}

export interface CustomProviderSummary {
	name: string;
	baseUrl: string;
	api: string;
	modelCount: number;
	hasKey: boolean;
}

// ─── Path resolution ───────────────────────────────────────────────────────

export function resolveModelsYmlPath(agentDir?: string): string {
	const dir = agentDir?.trim() || path.join(os.homedir(), ".omp", "agent");
	return path.join(dir, "models.yml");
}

// ─── Read ──────────────────────────────────────────────────────────────────

type YamlDoc = Record<string, unknown>;
type ProviderMap = Record<string, CustomProvider>;

/** Extract providers map from a parsed doc, returning empty if not a plain mapping. */
function extractProviders(doc: YamlDoc): ProviderMap {
	const providers = doc.providers;
	if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return {};
	return providers as ProviderMap;
}

/**
 * Three-state read:
 * 1. yml exists → parse; throw if root or `providers` is not a mapping.
 * 2. yml ENOENT but json exists → parse json (migration source).
 * 3. Neither exists → empty doc.
 */
export function readModelsYml(filePath?: string): { doc: YamlDoc; providers: ProviderMap } {
	const resolved = filePath ?? resolveModelsYmlPath();

	// State 1: yml exists
	const ymlResult = tryReadYml(resolved);
	if (ymlResult.found) return ymlResult.result!;

	// State 2: check legacy json
	const jsonPath = resolved.replace(/\.yml$/, ".json");
	const jsonResult = tryReadJson(jsonPath);
	if (jsonResult.found) return jsonResult.result!;

	// State 3: empty
	return { doc: {}, providers: {} };
}

function tryReadYml(resolved: string): { found: boolean; result?: { doc: YamlDoc; providers: ProviderMap } } {
	let raw: string;
	try {
		raw = fs.readFileSync(resolved, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { found: false };
		throw err;
	}
	const doc = parseYaml(raw) as unknown;
	if (doc === null) return { found: true, result: { doc: {}, providers: {} } };
	if (typeof doc !== "object" || Array.isArray(doc)) {
		throw new Error(`models.yml root must be a mapping, got ${Array.isArray(doc) ? "array" : typeof doc}`);
	}
	const docObj = doc as YamlDoc;
	if (docObj.providers !== undefined) {
		if (typeof docObj.providers !== "object" || docObj.providers === null || Array.isArray(docObj.providers)) {
			throw new Error(`models.yml "providers" must be a mapping, got ${Array.isArray(docObj.providers) ? "array" : typeof docObj.providers}`);
		}
	}
	return { found: true, result: { doc: docObj, providers: extractProviders(docObj) } };
}

function tryReadJson(resolved: string): { found: boolean; result?: { doc: YamlDoc; providers: ProviderMap } } {
	let raw: string;
	try {
		raw = fs.readFileSync(resolved, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { found: false };
		return { found: false }; // malformed json — skip silently
	}
	try {
		const doc = JSON.parse(raw) as unknown;
		if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { found: false };
		return { found: true, result: { doc: doc as YamlDoc, providers: extractProviders(doc as YamlDoc) } };
	} catch {
		return { found: false };
	}
}

export function listCustomProviders(filePath?: string): CustomProviderSummary[] {
	const { providers } = readModelsYml(filePath);
	return Object.entries(providers).map(([name, p]) => ({
		name,
		baseUrl: p.baseUrl ?? "",
		api: p.api ?? "openai-completions",
		modelCount: p.models?.length ?? 0,
		hasKey: Boolean(p.apiKey),
	}));
}

// ─── Write ─────────────────────────────────────────────────────────────────

export function upsertCustomProvider(
	name: string,
	provider: CustomProvider,
	filePath?: string,
): void {
	const resolved = filePath ?? resolveModelsYmlPath();
	fs.mkdirSync(path.dirname(resolved), { recursive: true });

	const { doc } = readModelsYml(resolved);
	// readModelsYml already validated providers is a mapping or absent.
	if (typeof doc.providers !== "object" || doc.providers === null) {
		doc.providers = {};
	}
	(doc.providers as ProviderMap)[name] = provider;
	atomicWrite(resolved, stringifyYaml(doc));
}

export function deleteCustomProvider(name: string, filePath?: string): boolean {
	const resolved = filePath ?? resolveModelsYmlPath();
	const { doc, providers } = readModelsYml(resolved);
	if (!(name in providers)) return false;
	delete (doc.providers as ProviderMap)[name];
	atomicWrite(resolved, stringifyYaml(doc));
	return true;
}

// ─── Internals ─────────────────────────────────────────────────────────────

/**
 * Write to temp, then rename (atomic on POSIX). On Windows where the target
 * may be locked, fall back to copy+unlink. Temp is always cleaned up.
 */
function atomicWrite(filePath: string, content: string): void {
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf-8");
	try {
		fs.renameSync(tmp, filePath);
	} catch {
		// Windows fallback: copy content over, then remove temp
		try {
			fs.copyFileSync(tmp, filePath);
		} finally {
			try { fs.unlinkSync(tmp); } catch { /* best effort */ }
		}
	}
}
