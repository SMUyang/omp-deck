import { Hono } from "hono";
import type {
	CpaUsageAggregate,
	CpaUsageHealth,
	CpaUsageResponse,
	CpaUsageTotals,
	CpaUsageWindow,
} from "@omp-deck/protocol";

import { parseInt10 } from "./config.ts";
import type { Config } from "./config.ts";

// ── Public types ──

export interface CpaUsageClientConfig {
	baseUrl: string;
	username: string;
	password: string;
	timeoutMs: number;
}

export type CpaUsageFetcher = (url: string, init: RequestInit) => Promise<Response>;

// ── Constants ──

const NOT_CONFIGURED =
	"CPA usage collector is not configured (set CPA_USAGE_BASE_URL/USERNAME/PASSWORD).";

interface WindowSpec {
	key: "h1" | "h24" | "d7";
	path: string;
}

const WINDOWS: readonly WindowSpec[] = [
	{ key: "h1", path: "/usage/1h" },
	{ key: "h24", path: "/usage/24h" },
	{ key: "d7", path: "/usage/7d" },
] as const;

// ── Runtime guards (untrusted JSON → typed values) ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── Normalization ──

function normalizeAggregate(raw: unknown): CpaUsageAggregate | undefined {
	if (!isRecord(raw)) return undefined;
	const n = optionalNumber(raw.n);
	if (n === undefined) return undefined;
	const agg: CpaUsageAggregate = { n };
	const keyId = optionalString(raw.key_id);
	if (keyId) agg.key_id = keyId;
	const model = optionalString(raw.model);
	if (model) agg.model = model;
	const account = optionalString(raw.account);
	if (account) agg.account = account;
	const inputTokens = optionalNumber(raw.input_tokens);
	if (inputTokens !== undefined) agg.input_tokens = inputTokens;
	const outputTokens = optionalNumber(raw.output_tokens);
	if (outputTokens !== undefined) agg.output_tokens = outputTokens;
	const cachedTokens = optionalNumber(raw.cached_tokens);
	if (cachedTokens !== undefined) agg.cached_tokens = cachedTokens;
	const reasoningTokens = optionalNumber(raw.reasoning_tokens);
	if (reasoningTokens !== undefined) agg.reasoning_tokens = reasoningTokens;
	const totalTokens = optionalNumber(raw.total_tokens);
	if (totalTokens !== undefined) agg.total_tokens = totalTokens;
	const errors = optionalNumber(raw.errors);
	if (errors !== undefined) agg.errors = errors;
	return agg;
}

function normalizeAggregateArray(raw: unknown): CpaUsageAggregate[] {
	if (!Array.isArray(raw)) return [];
	const result: CpaUsageAggregate[] = [];
	for (const item of raw) {
		const agg = normalizeAggregate(item);
		if (agg) result.push(agg);
	}
	return result;
}

function normalizeTotals(raw: unknown): CpaUsageTotals | undefined {
	if (!isRecord(raw)) return undefined;
	return {
		requests: optionalNumber(raw.requests) ?? 0,
		errors: optionalNumber(raw.errors) ?? 0,
		error_rate: optionalNumber(raw.error_rate) ?? 0,
		input_tokens: optionalNumber(raw.input_tokens) ?? 0,
		output_tokens: optionalNumber(raw.output_tokens) ?? 0,
		cached_tokens: optionalNumber(raw.cached_tokens) ?? 0,
		reasoning_tokens: optionalNumber(raw.reasoning_tokens) ?? 0,
		total_tokens: optionalNumber(raw.total_tokens) ?? 0,
	};
}

function normalizeWindow(raw: unknown): CpaUsageWindow | undefined {
	if (!isRecord(raw)) return undefined;
	const totals = normalizeTotals(raw.totals);
	if (!totals) return undefined;
	return {
		window_seconds: optionalNumber(raw.window_seconds) ?? 0,
		totals,
		per_api_key: normalizeAggregateArray(raw.per_api_key),
		per_model: normalizeAggregateArray(raw.per_model),
		per_account: normalizeAggregateArray(raw.per_account),
	};
}

function normalizeHealth(raw: unknown): CpaUsageHealth {
	if (!isRecord(raw)) return {};
	const health: CpaUsageHealth = {};
	if (typeof raw.ok === "boolean") health.ok = raw.ok;
	const status = optionalString(raw.status);
	if (status) health.status = status;
	return health;
}

// ── Fetch helpers ──

function buildBasicAuthHeader(username: string, password: string): string {
	const token = Buffer.from(`${username}:${password}`).toString("base64");
	return `Basic ${token}`;
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Build a per-request init; each call gets a fresh timeout signal. */
function buildInit(config: CpaUsageClientConfig): RequestInit {
	return {
		headers: { Authorization: buildBasicAuthHeader(config.username, config.password) },
		signal: AbortSignal.timeout(config.timeoutMs),
	};
}

/**
 * Sanitize a caught error message for use in the response. The collector URL
 * carries no credentials (auth is header-only), but we defensively strip the
 * password if it somehow appears in the message.
 */
function sanitizeErrorMessage(err: unknown, path: string, password: string): string {
	const message = err instanceof Error ? err.message : String(err);
	if (password && message.includes(password)) {
		return `${path}: request failed`;
	}
	return `${path}: ${message}`;
}

// ── Core response builder ──

export async function buildCpaUsageResponse(
	config: CpaUsageClientConfig | undefined,
	fetcher: CpaUsageFetcher,
): Promise<CpaUsageResponse> {
	const generatedAt = Date.now();

	if (!config) {
		return { available: false, generatedAt, error: NOT_CONFIGURED };
	}

	const password = config.password;

	// ── Health ──
	let health: CpaUsageHealth | undefined;
	let healthError: string | undefined;
	try {
		const resp = await fetcher(joinUrl(config.baseUrl, "/health"), buildInit(config));
		if (!resp.ok) {
			healthError = `collector /health returned HTTP ${resp.status}`;
		} else {
			const json: unknown = await resp.json().catch(() => null);
			health = normalizeHealth(json);
		}
	} catch (err) {
		healthError = sanitizeErrorMessage(err, "/health", password);
	}

	// ── Windows ──
	const windows: NonNullable<CpaUsageResponse["windows"]> = {};
	const windowErrors: string[] = [];

	for (const spec of WINDOWS) {
		try {
			const resp = await fetcher(joinUrl(config.baseUrl, spec.path), buildInit(config));
			if (!resp.ok) {
				windowErrors.push(`${spec.path} HTTP ${resp.status}`);
				continue;
			}
			const json: unknown = await resp.json().catch(() => null);
			const window = normalizeWindow(json);
			if (window) {
				windows[spec.key] = window;
			} else {
				windowErrors.push(`${spec.path} malformed`);
			}
		} catch (err) {
			windowErrors.push(sanitizeErrorMessage(err, spec.path, password));
		}
	}

	const hasHealth = health !== undefined;
	const hasWindows =
		windows.h1 !== undefined || windows.h24 !== undefined || windows.d7 !== undefined;
	const errors = [healthError, ...windowErrors].filter((e): e is string => e !== undefined);

	// Collector was configured but every call failed.
	if (!hasHealth && !hasWindows) {
		return {
			available: true,
			generatedAt,
			error: errors.length > 0 ? errors.join("; ") : "collector unreachable",
		};
	}

	const response: CpaUsageResponse = {
		available: true,
		generatedAt,
		...(hasHealth ? { health } : {}),
		...(hasWindows ? { windows } : {}),
	};
	if (errors.length > 0) {
		response.error = errors.join("; ");
	}
	return response;
}

// ── Config resolution ──

export function resolveCpaUsageConfig(): CpaUsageClientConfig | undefined {
	const baseUrl = process.env.CPA_USAGE_BASE_URL?.trim();
	const username = process.env.CPA_USAGE_USERNAME?.trim();
	const password = process.env.CPA_USAGE_PASSWORD?.trim();
	if (!baseUrl || !username || !password) return undefined;
	const timeoutMs = parseInt10(process.env.CPA_USAGE_TIMEOUT_MS, 10_000);
	return { baseUrl, username, password, timeoutMs };
}

// ── Router ──

export function buildCpaUsageRouter(_config: Config): Hono {
	const app = new Hono();
	app.get("/status/cpa-usage", async (c) => {
		const clientConfig = resolveCpaUsageConfig();
		const body = await buildCpaUsageResponse(clientConfig, fetch);
		return c.json(body);
	});
	return app;
}
