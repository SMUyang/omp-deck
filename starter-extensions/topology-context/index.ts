import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const CUSTOM_TYPE = "deck-session-topology-context";

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

export default function topologyContextExtension(pi: ExtensionAPI): void {
	pi.on("context", async (event, ctx) => {
		if (!shouldActivate(process.env)) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return undefined;
		const query = extractLatestUserText(event.messages);
		if (!query) return undefined;
		const apiBase = normalizeDeckApiBase(process.env.OMP_DECK_API_BASE);
		if (!apiBase) return undefined;
		const usage = ctx.getContextUsage();
		const contextPercent = typeof usage?.percent === "number" ? usage.percent : undefined;
		const url = buildContextFocusUrl(apiBase, sessionId, query, contextPercent);
		const timeoutMs = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS", 1500, 100, 30_000);
		const maxFocusChars = readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS", 50_000, 1000, 100_000);
		const focus = await fetchFocus(url, timeoutMs);
		if (!focus) return undefined;
		const bounded = focus.length > maxFocusChars ? `${focus.slice(0, maxFocusChars)}\n[truncated]` : focus;
		return { messages: appendTopologyContextMessage(event.messages, bounded) };
	});
}
