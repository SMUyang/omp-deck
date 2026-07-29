/**
 * Custom provider routes — CRUD for entries in `~/.omp/agent/models.yml`.
 *
 * These are OpenAI-compatible endpoints (SiliconFlow, DeepSeek, local proxies,
 * etc.) that omp discovers via models.yml. After any mutation we broadcast
 * `models_changed` and kill the shared transport so the model picker refreshes.
 */
import { Hono } from "hono";
import type { Config } from "./config.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { logger } from "./log.ts";
import {
	SUPPORTED_PROVIDER_APIS,
	deleteCustomProvider,
	listCustomProviders,
	resolveModelsYmlPath,
	upsertCustomProvider,
	type CustomProvider,
	type ProviderApi,
} from "./models-store.ts";

const log = logger("routes:providers");

export interface ProvidersRouterDeps {
	config: Pick<Config, "agentDir">;
	bridge: AgentBridge;
}

interface UpsertProviderBody {
	name: string;
	baseUrl: string;
	api?: string;
	apiKey?: string;
	auth?: "apiKey" | "none";
	models: Array<{
		id: string;
		name?: string;
		contextWindow?: number;
		maxTokens?: number;
	}>;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
	};
}

function isValidBody(value: unknown): value is UpsertProviderBody {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.name !== "string" || !v.name.trim()) return false;
	if (typeof v.baseUrl !== "string" || !v.baseUrl.trim()) return false;
	// auth: only apiKey (default) and none — oauth needs SDK registration
	const auth = typeof v.auth === "string" ? v.auth : "apiKey";
	if (auth !== "apiKey" && auth !== "none") return false;
	// apiKey required and non-empty unless auth === "none"
	if (auth !== "none" && (typeof v.apiKey !== "string" || !v.apiKey.trim())) return false;
	// api must be a string if present (enum validated in handler for error msg)
	if (v.api !== undefined && typeof v.api !== "string") return false;
	// models: non-empty, each with valid fields
	if (!Array.isArray(v.models) || v.models.length === 0) return false;
	for (const m of v.models) {
		if (typeof m !== "object" || m === null) return false;
		const mo = m as Record<string, unknown>;
		if (typeof mo.id !== "string" || !mo.id.trim()) return false;
		if (mo.name !== undefined && (typeof mo.name !== "string" || !mo.name.trim())) return false;
		if (mo.contextWindow !== undefined && (typeof mo.contextWindow !== "number" || mo.contextWindow <= 0)) return false;
		if (mo.maxTokens !== undefined && (typeof mo.maxTokens !== "number" || mo.maxTokens <= 0)) return false;
	}
	return true;
}

export function buildProvidersRouter(deps: ProvidersRouterDeps): Hono {
	const app = new Hono();
	const filePath = () => resolveModelsYmlPath(deps.config.agentDir);

	app.get("/providers/custom", (c) => {
		const providers = listCustomProviders(filePath());
		return c.json({ providers, path: filePath() });
	});

	app.post("/providers/custom", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON body" }, 400);
		}
		if (!isValidBody(body)) {
			return c.json({ error: "name, baseUrl, models[], and apiKey (unless auth=none) are required" }, 400);
		}

		const name = body.name.trim();
		const api = (body.api?.trim() || "openai-completions") as ProviderApi;
		if (!SUPPORTED_PROVIDER_APIS.includes(api)) {
			return c.json({ error: `api must be one of: ${SUPPORTED_PROVIDER_APIS.join(", ")}` }, 400);
		}

		const provider: CustomProvider = {
			baseUrl: body.baseUrl.trim(),
			api,
			...(body.auth === "none" ? { auth: "none" } : { apiKey: body.apiKey ?? "" }),
			models: body.models.map((m) => ({
				id: m.id,
				...(m.name ? { name: m.name } : {}),
				...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
				...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
			})),
			...(body.compat ? { compat: body.compat } : {}),
		};

		try {
			upsertCustomProvider(name, provider, filePath());
			log.info(`upserted custom provider "${name}" (${provider.models.length} models) → ${filePath()}`);
		} catch (err) {
			log.error(`failed to write provider "${name}"`, err);
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
		// Refresh shared transport (updates model picker immediately), but
		// active sessions always need a new session to use new models.
		try {
			await deps.bridge.refreshModels?.();
		} catch (err) {
			log.warn(`refreshModels failed after upsert — config saved`, err);
		}
		broadcastBus.broadcast({ type: "models_changed" });
		return c.json({ ok: true, name, reloadRequired: true });
	});

	app.delete("/providers/custom/:name", async (c) => {
		const name = c.req.param("name");
		try {
			const deleted = deleteCustomProvider(name, filePath());
			if (!deleted) return c.json({ error: "provider not found" }, 404);
			log.info(`deleted custom provider "${name}"`);
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
		try {
			await deps.bridge.refreshModels?.();
		} catch (err) {
			log.warn(`refreshModels failed after delete — config saved`, err);
		}
		broadcastBus.broadcast({ type: "models_changed" });
		return c.json({ ok: true, reloadRequired: true });
	});

	return app;
}
