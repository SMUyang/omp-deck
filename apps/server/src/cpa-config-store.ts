/**
 * Read/write CLIProxyAPI (CPA) config.json.
 *
 * CPA config lives at ~/.config/pi-cliproxyapi/config.json (cross-platform
 * via os.homedir()). It has three layers:
 *   - proxy: { endpoint, apiKey, providerPrefix }
 *   - builtinProviders: { openai: { enabled, apiOverride?, models[] }, ... }
 *   - customProviders: { name: { api, models[{id,name,contextWindow,...}] } }
 *
 * The discovery cache at ~/.config/pi-cliproxyapi/discovery-cache.json
 * caches the /v1/models response and must be cleared after config changes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CpaModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CpaCustomProvider {
	api: string;
	models: CpaModel[];
}

export interface CpaBuiltinProvider {
	enabled: boolean;
	apiOverride?: string;
	models?: string[];
}

export interface CpaProxy {
	endpoint: string;
	apiKey: string;
	providerPrefix?: string;
}

export interface CpaConfig {
	proxy?: CpaProxy;
	builtinProviders?: Record<string, CpaBuiltinProvider>;
	customProviders?: Record<string, CpaCustomProvider>;
}

/** Safe-to-send view (apiKey masked). */
export interface CpaConfigView {
	proxy?: { endpoint: string; hasKey: boolean; providerPrefix?: string };
	builtinProviders?: Record<string, CpaBuiltinProvider>;
	customProviders?: Record<string, CpaCustomProvider>;
}

// ── Path resolution ────────────────────────────────────────────────────────

export function resolveCpaDir(): string {
	const base = process.env.CPA_CONFIG_DIR?.trim();
	if (base) return base;
	return path.join(os.homedir(), ".config", "pi-cliproxyapi");
}

export function resolveCpaConfigPath(): string {
	return path.join(resolveCpaDir(), "config.json");
}

function resolveCachePath(): string {
	return path.join(resolveCpaDir(), "discovery-cache.json");
}

// ── Read / Write ───────────────────────────────────────────────────────────

export function readCpaConfig(): { config: CpaConfig | null; path: string; exists: boolean } {
	const configPath = resolveCpaConfigPath();
	if (!fs.existsSync(configPath)) {
		return { config: null, path: configPath, exists: false };
	}
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as CpaConfig;
		return { config: parsed, path: configPath, exists: true };
	} catch {
		return { config: null, path: configPath, exists: true };
	}
}

/** Mask sensitive fields for API responses. */
export function maskCpaConfig(config: CpaConfig): CpaConfigView {
	return {
		...(config.proxy
			? {
					proxy: {
						endpoint: config.proxy.endpoint,
						hasKey: !!config.proxy.apiKey,
						...(config.proxy.providerPrefix
							? { providerPrefix: config.proxy.providerPrefix }
							: {}),
					},
				}
			: {}),
		...(config.builtinProviders ? { builtinProviders: config.builtinProviders } : {}),
		...(config.customProviders ? { customProviders: config.customProviders } : {}),
	};
}

export function writeCpaConfig(updates: {
	proxy?: Partial<Pick<CpaProxy, "endpoint" | "apiKey" | "providerPrefix">>;
	customProviders?: Record<string, CpaCustomProvider>;
}): void {
	const dir = resolveCpaDir();
	const configPath = resolveCpaConfigPath();
	fs.mkdirSync(dir, { recursive: true });

	const existing = readCpaConfig().config ?? {};
	const merged: CpaConfig = { ...existing };

	if (updates.proxy) {
		merged.proxy = {
			endpoint: updates.proxy.endpoint ?? merged.proxy?.endpoint ?? "",
			apiKey: updates.proxy.apiKey ?? merged.proxy?.apiKey ?? "",
			...(updates.proxy.providerPrefix ?? merged.proxy?.providerPrefix
				? { providerPrefix: updates.proxy.providerPrefix ?? merged.proxy?.providerPrefix }
				: {}),
		};
	}

	if (updates.customProviders) {
		merged.customProviders = updates.customProviders;
	}

	atomicWrite(configPath, JSON.stringify(merged, null, 2) + "\n");
}

export function clearDiscoveryCache(): { ok: boolean; existed: boolean } {
	const cachePath = resolveCachePath();
	const existed = fs.existsSync(cachePath);
	if (existed) fs.unlinkSync(cachePath);
	return { ok: true, existed };
}

// ── Atomic write (same pattern as models-store.ts) ────────────────────────

function atomicWrite(filePath: string, content: string): void {
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf-8");
	try {
		fs.renameSync(tmp, filePath);
	} catch {
		try {
			fs.copyFileSync(tmp, filePath);
			fs.unlinkSync(tmp);
		} catch {
			// Last resort: direct write
			fs.writeFileSync(filePath, content, "utf-8");
			try { fs.unlinkSync(tmp); } catch { /* ignore */ }
		}
	}
}
