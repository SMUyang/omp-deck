/**
 * Orientation routes
 *
 * Surface the three session-shaping artifacts (prelude, /start command,
 * maintenance-gate config) as a deck-managed REST API so the Settings UI
 * can read + edit them without anyone touching server source. See
 * `orientation-store.ts` for the persistence model.
 */

import { Hono } from "hono";
import type {
	MaintenanceGateState,
	PreludeResponse,
	StartCommand,
	TopologyContextInjectionState,
	TopologyRerankConfig,
	UpdatePreludeRequest,
	UpdateStartCommandRequest,
} from "@omp-deck/protocol";

import {
	DEFAULT_PRELUDE,
	MAINTENANCE_GATE_ENV_KEYS,
	TOPOLOGY_CONTEXT_ENV_KEYS,
	TOPOLOGY_RERANK_ENV_KEYS,
	getEffectivePrelude,
	getPreludeFilePath,
	readMaintenanceGateState,
	readPreludeOverride,
	readStartCommand,
	readTopologyContextInjectionState,
	readTopologyRerankConfig,
	writePreludeOverride,
	writeStartCommand,
} from "./orientation-store.ts";
import {
	appendEnvAudit,
	applyManagedEnvUpdatesToProcess,
	writeManagedEnvUpdates,
} from "./env-store.ts";
import { ENV_SCHEMA_BY_KEY, validateEnvValue } from "./env-schema.ts";
import { normalizeDeckApiOrigin, isLoopbackApiOrigin } from "./api-base.ts";

async function persistEnvUpdates(updates: Record<string, string | null>): Promise<void> {
	await writeManagedEnvUpdates(updates);
	applyManagedEnvUpdatesToProcess(updates);
	const set = Object.keys(updates).filter((k) => updates[k] !== null);
	const unset = Object.keys(updates).filter((k) => updates[k] === null);
	if (set.length > 0) await appendEnvAudit("set", set);
	if (unset.length > 0) await appendEnvAudit("unset", unset);
}

function validateEnvUpdates(updates: Record<string, string | null>): string | null {
	for (const [key, value] of Object.entries(updates)) {
		if (value === null) continue;
		const entry = ENV_SCHEMA_BY_KEY.get(key);
		if (!entry) continue;
		const err = validateEnvValue(entry, value);
		if (err) return `${key}: ${err}`;
	}
	return null;
}


function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildOrientationRouter(): Hono {
	const app = new Hono();

	// ── prelude ───────────────────────────────────────────────────────────

	app.get("/orientation/prelude", (c) => {
		const body: PreludeResponse = {
			path: getPreludeFilePath(),
			default: DEFAULT_PRELUDE,
			override: readPreludeOverride(),
			effective: getEffectivePrelude(),
		};
		return c.json(body);
	});

	app.put("/orientation/prelude", async (c) => {
		let body: UpdatePreludeRequest;
		try {
			body = (await c.req.json()) as UpdatePreludeRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (body.value !== null && typeof body.value !== "string") {
			return c.json({ error: "value must be string or null" }, 400);
		}
		writePreludeOverride(body.value);
		const resp: PreludeResponse = {
			path: getPreludeFilePath(),
			default: DEFAULT_PRELUDE,
			override: readPreludeOverride(),
			effective: getEffectivePrelude(),
		};
		return c.json(resp);
	});

	// ── /start command ────────────────────────────────────────────────────

	app.get("/orientation/start", (c) => {
		const body: StartCommand = readStartCommand();
		return c.json(body);
	});

	app.put("/orientation/start", async (c) => {
		let body: UpdateStartCommandRequest;
		try {
			body = (await c.req.json()) as UpdateStartCommandRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const description = typeof body.description === "string" ? body.description : "";
		const text = typeof body.body === "string" ? body.body : "";
		writeStartCommand(description, text);
		const resp: StartCommand = readStartCommand();
		return c.json(resp);
	});

	// ── maintenance gate ──────────────────────────────────────────────────

	app.get("/orientation/maintenance-gate", (c) => {
		const body: MaintenanceGateState = readMaintenanceGateState();
		return c.json(body);
	});

	app.get("/orientation/topology-context-injection", (c) => {
		const body: TopologyContextInjectionState = readTopologyContextInjectionState();
		return c.json(body);
	});

	app.put("/orientation/topology-context-injection", async (c) => {
		let body: Record<string, unknown>;
		try {
			const raw = await c.req.json();
			if (!isJsonRecord(raw)) return c.json({ error: "json body must be an object" }, 400);
			body = raw;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const updates: Record<string, string | null> = {};
		if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
			if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be boolean" }, 400);
			updates[TOPOLOGY_CONTEXT_ENV_KEYS.enabled] = body.enabled ? "1" : null;
		}
		if (Object.prototype.hasOwnProperty.call(body, "apiBase")) {
			if (body.apiBase === null || body.apiBase === undefined) {
				updates[TOPOLOGY_CONTEXT_ENV_KEYS.apiBase] = null;
			} else if (typeof body.apiBase !== "string") {
				return c.json({ error: "apiBase must be a loopback HTTP URL string or null" }, 400);
			} else if (body.apiBase.trim() === "") {
				updates[TOPOLOGY_CONTEXT_ENV_KEYS.apiBase] = null;
			} else {
				let normalized: string;
				try {
					normalized = normalizeDeckApiOrigin(body.apiBase);
				} catch {
					return c.json({ error: "apiBase must be a loopback HTTP URL" }, 400);
				}
				if (!isLoopbackApiOrigin(normalized)) {
					return c.json({ error: "apiBase must be a loopback HTTP URL" }, 400);
				}
				updates[TOPOLOGY_CONTEXT_ENV_KEYS.apiBase] = normalized;
			}
		}

		const numericKnobs: Array<["maxFocusChars" | "timeoutMs", string]> = [
			["maxFocusChars", TOPOLOGY_CONTEXT_ENV_KEYS.maxFocusChars],
			["timeoutMs", TOPOLOGY_CONTEXT_ENV_KEYS.timeoutMs],
		];
		for (const [field, envKey] of numericKnobs) {
			if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
			const raw = body[field];
			if (raw === null || raw === undefined) {
				updates[envKey] = null;
				continue;
			}
			if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
				return c.json({ error: `${String(field)} must be a positive integer or null` }, 400);
			}
			updates[envKey] = String(raw);
		}

		const err = validateEnvUpdates(updates);
		if (err) return c.json({ error: err }, 400);
		await persistEnvUpdates(updates);
		const resp: TopologyContextInjectionState = readTopologyContextInjectionState();
		return c.json(resp);
	});


	app.put("/orientation/maintenance-gate", async (c) => {
		let body: Record<string, unknown>;
		try {
			const raw = await c.req.json();
			if (!isJsonRecord(raw)) return c.json({ error: "json body must be an object" }, 400);
			body = raw;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const updates: Record<string, string | null> = {};

		if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
			// `enabled` is the UI affordance; we store its inverse as
			// OMP_DECK_MAINTENANCE_GATE_DISABLED=1 (truthy = off). `null`
			// clears the override and reverts to the implicit default (on).
			if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be boolean" }, 400);
			updates[MAINTENANCE_GATE_ENV_KEYS.disabled] = body.enabled ? null : "1";
		}

		const numericKnobs: Array<["minOpMsgs" | "minReleaseAgeMs" | "fireFloorMs", string]> = [
			["minOpMsgs", MAINTENANCE_GATE_ENV_KEYS.minOpMsgs],
			["minReleaseAgeMs", MAINTENANCE_GATE_ENV_KEYS.minReleaseAgeMs],
			["fireFloorMs", MAINTENANCE_GATE_ENV_KEYS.fireFloorMs],
		];
		for (const [field, envKey] of numericKnobs) {
			if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
			const raw = body[field];
			if (raw === null || raw === undefined) {
				updates[envKey] = null;
				continue;
			}
			if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
				return c.json({ error: `${String(field)} must be a positive integer or null` }, 400);
			}
			updates[envKey] = String(raw);
		}

		const err = validateEnvUpdates(updates);
		if (err) return c.json({ error: err }, 400);
		await persistEnvUpdates(updates);

		const resp: MaintenanceGateState = readMaintenanceGateState();
		return c.json(resp);
	});


	// ── topology rerank ──────────────────────────────────────────────────

	app.get("/orientation/topology-rerank", (c) => {
		const body: TopologyRerankConfig = readTopologyRerankConfig();
		return c.json(body);
	});

	app.put("/orientation/topology-rerank", async (c) => {
		let body: Record<string, unknown>;
		try {
			const raw = await c.req.json();
			if (!isJsonRecord(raw)) return c.json({ error: "json body must be an object" }, 400);
			body = raw;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const updates: Record<string, string | null> = {};
		if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
			if (body.enabled === null || body.enabled === undefined) {
				updates[TOPOLOGY_RERANK_ENV_KEYS.enabled] = null;
			} else if (typeof body.enabled !== "boolean") {
				return c.json({ error: "enabled must be boolean or null" }, 400);
			} else {
				updates[TOPOLOGY_RERANK_ENV_KEYS.enabled] = body.enabled ? "1" : "0";
			}
		}

		if (Object.prototype.hasOwnProperty.call(body, "rerankModelRole")) {
			const raw = body.rerankModelRole;
			if (raw === null || raw === undefined) {
				updates[TOPOLOGY_RERANK_ENV_KEYS.rerankModelRole] = null;
			} else if (typeof raw !== "string") {
				return c.json({ error: "rerankModelRole must be a string or null" }, 400);
			} else {
				const role = raw.trim();
				updates[TOPOLOGY_RERANK_ENV_KEYS.rerankModelRole] = role ? role : null;
			}
		}

		const integerKnobs: Array<["minCandidateNodes" | "timeoutMs", string]> = [
			["minCandidateNodes", TOPOLOGY_RERANK_ENV_KEYS.minCandidateNodes],
			["timeoutMs", TOPOLOGY_RERANK_ENV_KEYS.timeoutMs],
		];
		for (const [field, envKey] of integerKnobs) {
			if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
			const raw = body[field];
			if (raw === null || raw === undefined) {
				updates[envKey] = null;
				continue;
			}
			if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
				return c.json({ error: `${String(field)} must be a positive integer or null` }, 400);
			}
			updates[envKey] = String(raw);
		}

		if (Object.prototype.hasOwnProperty.call(body, "minContextPercent")) {
			const raw = body.minContextPercent;
			if (raw === null || raw === undefined) {
				updates[TOPOLOGY_RERANK_ENV_KEYS.minContextPercent] = null;
			} else if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
				return c.json({ error: "minContextPercent must be a non-negative number or null" }, 400);
			} else {
				updates[TOPOLOGY_RERANK_ENV_KEYS.minContextPercent] = String(raw);
			}
		}

		if (Object.prototype.hasOwnProperty.call(body, "localConfidenceBelow")) {
			const raw = body.localConfidenceBelow;
			if (raw === null || raw === undefined) {
				updates[TOPOLOGY_RERANK_ENV_KEYS.localConfidenceBelow] = null;
			} else if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
				return c.json({ error: "localConfidenceBelow must be a number 0–1 or null" }, 400);
			} else {
				updates[TOPOLOGY_RERANK_ENV_KEYS.localConfidenceBelow] = String(raw);
			}
		}

		if (Object.prototype.hasOwnProperty.call(body, "provider")) {
			const raw = body.provider;
			if (raw === null || raw === undefined) {
				updates[TOPOLOGY_RERANK_ENV_KEYS.provider] = null;
			} else if (raw !== "model_role" && raw !== "http") {
				return c.json({ error: "provider must be \"model_role\" or \"http\" or null" }, 400);
			} else {
				updates[TOPOLOGY_RERANK_ENV_KEYS.provider] = String(raw);
			}
		}

		if (Object.prototype.hasOwnProperty.call(body, "http") && body.http !== null) {
			const http = body.http;
			if (typeof http !== "object" || Array.isArray(http)) {
				return c.json({ error: "http must be an object or null" }, 400);
			}
			const record = http as Record<string, unknown>;
			const stringFields: Array<["baseUrl" | "endpointPath" | "authHeaderName" | "protocol" | "model", string]> = [
				["baseUrl", TOPOLOGY_RERANK_ENV_KEYS.httpBaseUrl],
				["endpointPath", TOPOLOGY_RERANK_ENV_KEYS.httpEndpointPath],
				["authHeaderName", TOPOLOGY_RERANK_ENV_KEYS.httpAuthHeaderName],
				["protocol", TOPOLOGY_RERANK_ENV_KEYS.httpProtocol],
				["model", TOPOLOGY_RERANK_ENV_KEYS.httpModel],
			];
			for (const [field, envKey] of stringFields) {
				if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
				const raw = record[field];
				if (raw === null || raw === undefined) {
					updates[envKey] = null;
					continue;
				}
				if (typeof raw !== "string") {
					return c.json({ error: `${field} must be a string or null` }, 400);
				}
				const value = raw.trim();
				updates[envKey] = value ? value : null;
			}
			const intFields: Array<["timeoutMs" | "minCandidateNodes", string]> = [
				["timeoutMs", TOPOLOGY_RERANK_ENV_KEYS.httpTimeoutMs],
				["minCandidateNodes", TOPOLOGY_RERANK_ENV_KEYS.httpMinCandidateNodes],
			];
			for (const [field, envKey] of intFields) {
				if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
				const raw = record[field];
				if (raw === null || raw === undefined) {
					updates[envKey] = null;
					continue;
				}
				if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
					return c.json({ error: `${field} must be a positive integer or null` }, 400);
				}
				updates[envKey] = String(raw);
			}
			const numberFields: Array<["confidenceThreshold" | "minContextPercent", string, (n: number) => boolean]> = [
				["confidenceThreshold", TOPOLOGY_RERANK_ENV_KEYS.httpConfidenceThreshold, (n) => n >= 0 && n <= 1],
				["minContextPercent", TOPOLOGY_RERANK_ENV_KEYS.httpMinContextPercent, (n) => n >= 0],
			];
			for (const [field, envKey, check] of numberFields) {
				if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
				const raw = record[field];
				if (raw === null || raw === undefined) {
					updates[envKey] = null;
					continue;
				}
				if (typeof raw !== "number" || !Number.isFinite(raw) || !check(raw)) {
					return c.json({ error: `${field} must be a valid number or null` }, 400);
				}
				updates[envKey] = String(raw);
			}
		} else if (body.http === null) {
			for (const envKey of [TOPOLOGY_RERANK_ENV_KEYS.httpBaseUrl, TOPOLOGY_RERANK_ENV_KEYS.httpEndpointPath, TOPOLOGY_RERANK_ENV_KEYS.httpProtocol, TOPOLOGY_RERANK_ENV_KEYS.httpTimeoutMs, TOPOLOGY_RERANK_ENV_KEYS.httpConfidenceThreshold, TOPOLOGY_RERANK_ENV_KEYS.httpMinCandidateNodes, TOPOLOGY_RERANK_ENV_KEYS.httpMinContextPercent, TOPOLOGY_RERANK_ENV_KEYS.httpAuthHeaderName, TOPOLOGY_RERANK_ENV_KEYS.httpModel]) {
				updates[envKey] = null;
			}
		}

		const err = validateEnvUpdates(updates);
		if (err) return c.json({ error: err }, 400);
		await persistEnvUpdates(updates);
		const resp: TopologyRerankConfig = readTopologyRerankConfig();
		return c.json(resp);
	});
	return app;
}
