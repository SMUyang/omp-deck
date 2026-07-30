/**
 * Routes for CLIProxyAPI (CPA) config management.
 *
 *   GET  /api/cpa/config        — read CPA config.json (apiKey masked)
 *   PUT  /api/cpa/config        — update proxy settings and/or custom providers
 *   POST /api/cpa/test          — test connection to CPA endpoint (/v1/models)
 *   POST /api/cpa/clear-cache   — delete discovery-cache.json
 */

import { Hono } from "hono";
import {
	type CpaConfig,
	type CpaCustomProvider,
	readCpaConfig,
	maskCpaConfig,
	writeCpaConfig,
	clearDiscoveryCache,
	resolveCpaConfigPath,
} from "./cpa-config-store.ts";

// ── Request body types ─────────────────────────────────────────────────────

interface UpdateCpaConfigBody {
	proxy?: {
		endpoint?: string;
		apiKey?: string;
		providerPrefix?: string;
	};
	customProviders?: Record<string, CpaCustomProvider>;
}

interface TestCpaBody {
	endpoint?: string;
	apiKey?: string;
}

// ── Router ─────────────────────────────────────────────────────────────────

export function buildCpaConfigRouter(): Hono {
	const app = new Hono();

	// Read CPA config (masked)
	app.get("/cpa/config", (c) => {
		const { config, path, exists } = readCpaConfig();
		if (!config) {
			return c.json({
				config: null,
				path,
				exists,
			});
		}
		return c.json({
			config: maskCpaConfig(config),
			path,
			exists,
		});
	});

	// Update CPA config
	app.put("/cpa/config", async (c) => {
		let body: UpdateCpaConfigBody;
		try {
			body = (await c.req.json()) as UpdateCpaConfigBody;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const updates: Parameters<typeof writeCpaConfig>[0] = {};

		if (body.proxy) {
			const current = readCpaConfig().config?.proxy;
			updates.proxy = {
				endpoint: body.proxy.endpoint ?? current?.endpoint,
				apiKey: body.proxy.apiKey ?? current?.apiKey,
				providerPrefix: body.proxy.providerPrefix ?? current?.providerPrefix,
			};
			// Don't write empty strings over existing values
			if (!updates.proxy.endpoint) delete updates.proxy.endpoint;
			if (!updates.proxy.apiKey) delete updates.proxy.apiKey;
			if (updates.proxy.providerPrefix === undefined) delete updates.proxy.providerPrefix;
		}

		if (body.customProviders) {
			updates.customProviders = body.customProviders;
		}

		if (!updates.proxy && !updates.customProviders) {
			return c.json({ error: "no changes provided" }, 400);
		}

		try {
			writeCpaConfig(updates);
			const { config } = readCpaConfig();
			return c.json({
				ok: true,
				config: config ? maskCpaConfig(config) : null,
				path: resolveCpaConfigPath(),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ error: `failed to write CPA config: ${msg}` }, 500);
		}
	});

	// Test CPA connection — fetch /v1/models from the endpoint
	app.post("/cpa/test", async (c) => {
		let body: TestCpaBody;
		try {
			body = (await c.req.json()) as TestCpaBody;
		} catch {
			body = {};
		}

		// Resolve endpoint/key: body override > config.json
		const config = readCpaConfig().config;
		const endpoint = body.endpoint?.trim() || config?.proxy?.endpoint?.trim();
		const apiKey = body.apiKey?.trim() || config?.proxy?.apiKey?.trim();

		if (!endpoint) {
			return c.json({ ok: false, error: "no CPA endpoint configured" }, 400);
		}

		const url = `${endpoint.replace(/\/+$/, "")}/models`;
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			const resp = await fetch(url, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (!resp.ok) {
				return c.json({
					ok: false,
					error: `CPA returned HTTP ${resp.status} ${resp.statusText}`,
				});
			}

			const json: unknown = await resp.json().catch(() => null);
			const models = extractModelIds(json);
			return c.json({
				ok: true,
				modelCount: models.length,
				models: models.slice(0, 100),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: msg });
		}
	});

	// Clear discovery cache
	app.post("/cpa/clear-cache", (c) => {
		const result = clearDiscoveryCache();
		return c.json(result);
	});

	return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractModelIds(json: unknown): string[] {
	if (typeof json !== "object" || json === null) return [];
	// OpenAI-style: { data: [{ id: "..." }] }
	const data = (json as Record<string, unknown>).data;
	if (Array.isArray(data)) {
		return data
			.map((m) => {
				if (typeof m === "object" && m !== null) {
					const id = (m as Record<string, unknown>).id;
					return typeof id === "string" ? id : null;
				}
				return null;
			})
			.filter((id): id is string => id !== null);
	}
	return [];
}
