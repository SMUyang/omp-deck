import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type {
	CreateContextEvidenceRequest,
	UpdateContextEvidenceRequest,
} from "@omp-deck/protocol";

export const CUSTOM_TYPE = "deck-session-topology-context";


// ── Token & hash helpers ────────────────────────────────────────────────────

/** Compute saved tokens: max(0, before - after). Returns null when either input is null. */
export function computeSavedTokens(
	beforeTokens: number | null,
	afterTokens: number | null,
): number | null {
	if (beforeTokens == null || afterTokens == null) return null;
	return Math.max(0, beforeTokens - afterTokens);
}

/** Compute saved percent: round(saved / before * 100, 1). Returns null when either input is null. */
export function computeSavedPercent(
	beforeTokens: number | null,
	savedTokens: number | null,
): number | null {
	if (beforeTokens == null || savedTokens == null) return null;
	if (beforeTokens === 0) return savedTokens === 0 ? 0 : null;
	return Math.round((savedTokens / beforeTokens) * 1000) / 10;
}

/** Estimate focus tokens: ceil(chars / 4). Per plan contract, method = "chars_div_4". */
export function computeFocusEstimatedTokens(focus: string): number {
	return Math.ceil(focus.length / 4);
}

/** SHA-256 hex digest of focus text. */
export function sha256Hex(input: string): string {
	return Bun.SHA256.hash(input, "hex") as string;
}

/** Build the first 240-char preview from the focus text. */
export function buildFocusPreview(focus: string): string {
	return focus.slice(0, 240);
}

// ── Message helpers ─────────────────────────────────────────────────────────

interface TextPart {
	type: "text";
	text: string;
}

interface TopologyContextMessage {
	role: "custom";
	customType: typeof CUSTOM_TYPE;
	content: string;
	display: false;
	attribution: "agent";
	timestamp: number;
}

export function normalizeDeckApiBase(raw: string | undefined): string | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const withoutSlash = trimmed.replace(/\/+$/, "");
	return withoutSlash.endsWith("/api") ? withoutSlash : `${withoutSlash}/api`;
}

export function isLoopbackApiBase(raw: string | null): boolean {
	if (!raw) return false;
	try {
		const url = new URL(raw);
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
	} catch {
		return false;
	}
}

export function shouldActivate(env: Record<string, string | undefined>): boolean {
	const enabled = ["1", "true", "yes", "on"].includes(
		(env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED ?? "").trim().toLowerCase(),
	);
	if (!enabled) return false;
	return isLoopbackApiBase(normalizeDeckApiBase(env.OMP_DECK_API_BASE));
}

export function buildContextFocusUrl(base: string, sessionId: string, query: string, contextPercent?: number): string {
	const normalized = normalizeDeckApiBase(base);
	if (!normalized) throw new Error("missing OMP_DECK_API_BASE");
	const url = new URL(`${normalized}/sessions/${encodeURIComponent(sessionId)}/context-focus`);
	url.searchParams.set("q", query);
	if (typeof contextPercent === "number" && Number.isFinite(contextPercent)) {
		url.searchParams.set("contextPercent", String(contextPercent));
	}
	return url.toString();
}

function isTextPart(value: unknown): value is TextPart {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || value.type !== "text") return false;
	return "text" in value && typeof value.text === "string";
}

function readRole(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("role" in value)) return null;
	return typeof value.role === "string" ? value.role : null;
}

function readContent(value: unknown): unknown {
	if (!value || typeof value !== "object" || !("content" in value)) return undefined;
	return value.content;
}

export function extractLatestUserText(messages: readonly unknown[]): string | null {
	const last = messages[messages.length - 1];
	if (readRole(last) !== "user") return null;
	const content = readContent(last);
	if (typeof content === "string") return content.trim() || null;
	if (!Array.isArray(content)) return null;
	const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
	return text || null;
}

export function parseFocusResponse(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("focus" in value)) return null;
	return typeof value.focus === "string" ? value.focus : null;
}

function parseEventIdResponse(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("eventId" in value)) return null;
	return typeof value.eventId === "string" && value.eventId ? value.eventId : null;
}

function readPayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || !("payload" in value)) return undefined;
	return value.payload;
}

export function appendTopologyContextMessage<T>(messages: readonly T[], focus: string): Array<T | TopologyContextMessage> {
	return [
		...messages,
		{
			role: "custom",
			customType: CUSTOM_TYPE,
			content: focus,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		},
	];
}

/**
 * Replace old messages with topology focus, keeping only the most recent N user
 * turns (including assistant/tool responses after each user message).
 *
 * Returns a new array: [focusMessage, ...recentTurns].
 */
export function replaceTopologyContext<T>(messages: readonly T[], focus: string, keepRecentUserTurns: number): Array<T | TopologyContextMessage> {
	const kept: T[] = [];
	let userCount = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		kept.unshift(messages[i]!);
		if (readRole(messages[i]) === "user") {
			userCount++;
			if (userCount >= keepRecentUserTurns) break;
		}
	}
	return [
		{
			role: "custom",
			customType: CUSTOM_TYPE,
			content: focus,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		},
		...kept,
	];
}

export function readBoundedEnvInt(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name]?.trim();
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
}

async function fetchFocus(url: string, timeoutMs: number): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return null;
		return parseFocusResponse(await res.json());
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<Response | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export async function createContextEvidence(
	base: string,
	sessionId: string,
	params: CreateContextEvidenceRequest,
	timeoutMs: number,
): Promise<string | null> {
	const normalized = normalizeDeckApiBase(base);
	if (!isLoopbackApiBase(normalized)) return null;
	const url = `${normalized}/sessions/${encodeURIComponent(sessionId)}/context-evidence`;
	const response = await postJson(url, params, timeoutMs);
	if (!response?.ok) return null;
	try {
		return parseEventIdResponse(await response.json());
	} catch {
		return null;
	}
}

export async function updateContextEvidence(
	base: string,
	sessionId: string,
	eventId: string,
	params: UpdateContextEvidenceRequest,
	timeoutMs: number,
): Promise<boolean> {
	const normalized = normalizeDeckApiBase(base);
	if (!isLoopbackApiBase(normalized) || !eventId) return false;
	const url = `${normalized}/sessions/${encodeURIComponent(sessionId)}/context-evidence/${encodeURIComponent(eventId)}`;
	const response = await postJson(url, params, timeoutMs);
	return response?.ok === true;
}

// ── Extension hooks ──────────────────────────────────────────────────────────

/**
 * Per-session evidence state tracked across the context → provider lifecycle.
 * Reset after provider_payload_observed or failed/timeout.
 */
interface PendingEvidence {
	eventId: string;
	focus: string;
}

export default function topologyContextExtension(pi: ExtensionAPI): void {
	const pending = new Map<string, PendingEvidence>();

	pi.on("context", async (event, ctx) => {
		if (!shouldActivate(process.env)) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return undefined;
		const query = extractLatestUserText(event.messages);
		if (!query) return undefined;
		const apiBase = normalizeDeckApiBase(process.env.OMP_DECK_API_BASE);
		if (!apiBase) return undefined;

		const usage = ctx.getContextUsage();
		const beforeTokens = typeof usage?.tokens === "number" ? usage.tokens : null;
		const beforePercent = typeof usage?.percent === "number" ? usage.percent : null;
		const contextPercent = typeof usage?.percent === "number" ? usage.percent : undefined;
		const url = buildContextFocusUrl(apiBase, sessionId, query, contextPercent);
		const timeoutMs = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS", 1500, 100, 30_000);
		const maxFocusChars = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS", 50_000, 1000, 100_000);

		const focus = await fetchFocus(url, timeoutMs);

		if (!focus) {
			const failurePreview = buildFocusPreview(`Topology focus fetch failed for query: ${query}`);
			await createContextEvidence(apiBase, sessionId, {
				status: "failed",
				mechanism: "context_hook",
				beforeTokens,
				beforePercent,
				focusHash: sha256Hex(`focus-fetch-failed\n${sessionId}\n${query}`),
				focusPreview: failurePreview,
				estimatedFocusTokens: 0,
				focusEstimateMethod: "chars_div_4",
				errorMessage: "context-focus request failed",
			}, timeoutMs);
			return undefined;
		}

		const bounded = focus.length > maxFocusChars ? `${focus.slice(0, maxFocusChars)}\n[truncated]` : focus;
		const focusHash = sha256Hex(bounded);
		const focusPreview = buildFocusPreview(bounded);
		const focusEstimatedTokens = Math.ceil(bounded.length / 4);

		const eventId = await createContextEvidence(apiBase, sessionId, {
			status: "constructed",
			mechanism: "context_hook",
			beforeTokens,
			beforePercent,
			focusHash,
			focusPreview,
			estimatedFocusTokens: focusEstimatedTokens,
			focusEstimateMethod: "chars_div_4",
		}, timeoutMs);
		if (eventId) {
			await updateContextEvidence(apiBase, sessionId, eventId, { status: "handler_returned" }, timeoutMs);
			pending.set(sessionId, { eventId, focus: bounded });
		}


		const keepTurns = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_KEEP_TURNS", 3, 1, 20);
		return { messages: replaceTopologyContext(event.messages, bounded, keepTurns) };
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const evidence = pending.get(sessionId);
		if (!evidence) return;

		// The event carries the full provider payload. We check whether our
		// injected focus text appears anywhere in the payload to prove it
		// survived through convertToLlm().
		const payloadRaw = JSON.stringify(readPayload(_event) ?? "");

		// JSON.stringify escapes special characters (e.g. newlines → \n).
		// We must match the escaped form so focus text in the payload is found.
		function escapeForJsonMatch(text: string): string {
			return JSON.stringify(text).slice(1, -1);
		}

		if (!payloadRaw.includes(escapeForJsonMatch(evidence.focus))) return;
		const apiBase = normalizeDeckApiBase(process.env.OMP_DECK_API_BASE);
		if (!isLoopbackApiBase(apiBase)) return;
		const timeoutMs = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS", 1500, 100, 30_000);
		const updated = await updateContextEvidence(
			apiBase,
			sessionId,
			evidence.eventId,
			{ status: "provider_payload_observed" },
			timeoutMs,
		);
		if (updated) pending.delete(sessionId);
	});
}
