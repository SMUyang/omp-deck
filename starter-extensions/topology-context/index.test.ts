import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
	appendTopologyContextMessage,
	buildContextFocusUrl,
	extractLatestUserText,
	isLoopbackApiBase,
	normalizeDeckApiBase,
	parseFocusResponse,
	readBoundedEnvInt,
	replaceTopologyContext,
	shouldActivate,
} from "./index.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] });
const tool = (text: string) => ({ role: "tool" as const, content: [{ type: "text" as const, text }] });

describe("topology-context extension helpers", () => {
	test("normalizes configured deck API base", () => {
		expect(normalizeDeckApiBase("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/api");
		expect(normalizeDeckApiBase("http://127.0.0.1:8787/api/")).toBe("http://127.0.0.1:8787/api");
		expect(normalizeDeckApiBase(undefined)).toBeNull();
	});

	test("accepts only loopback API base", () => {
		expect(isLoopbackApiBase("http://127.0.0.1:8787/api")).toBe(true);
		expect(isLoopbackApiBase("http://localhost:8787/api")).toBe(true);
		expect(isLoopbackApiBase("http://[::1]:8787/api")).toBe(true);
		expect(isLoopbackApiBase("https://example.com/api")).toBe(false);
		expect(isLoopbackApiBase("not a url")).toBe(false);
	});

	test("activates only when enabled and deck API base is present", () => {
		expect(shouldActivate({ OMP_DECK_TOPOLOGY_CONTEXT_ENABLED: "1", OMP_DECK_API_BASE: "http://127.0.0.1:8787/api" })).toBe(true);
		expect(shouldActivate({ OMP_DECK_API_BASE: "http://127.0.0.1:8787/api" })).toBe(false);
		expect(shouldActivate({ OMP_DECK_TOPOLOGY_CONTEXT_ENABLED: "1" })).toBe(false);
	});

	test("bounded env int rejects decimals instead of truncating", () => {
		const prev = process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS;
		try {
			process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS = "1500.7";
			expect(readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS", 1500, 100, 30_000)).toBe(1500);
			process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS = "2500";
			expect(readBoundedEnvInt("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS", 1500, 100, 30_000)).toBe(2500);
		} finally {
			if (prev === undefined) delete process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS;
			else process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS = prev;
		}
	});

	test("builds context focus URL with encoded session and query", () => {
		expect(buildContextFocusUrl("http://deck/api", "s/1", "query text", 12.5)).toBe(
			"http://deck/api/sessions/s%2F1/context-focus?q=query+text&contextPercent=12.5",
		);
	});

	test("extracts latest user text only when tail is user text", () => {
		expect(extractLatestUserText([user("hello")])).toBe("hello");
		expect(extractLatestUserText([user("hello"), assistant("answer")])).toBeNull();
		expect(extractLatestUserText([{ role: "custom", customType: "x", content: "hidden" }])).toBeNull();
	});

	test("parses only string focus responses", () => {
		expect(parseFocusResponse({ focus: "abc" })).toBe("abc");
		expect(parseFocusResponse({ focus: "" })).toBe("");
		expect(parseFocusResponse({ focus: 1 })).toBeNull();
		expect(parseFocusResponse(null)).toBeNull();
	});

	test("returns replacement array instead of mutating input", () => {
		const original = [user("hello")];
		const next = appendTopologyContextMessage(original, "focus text");
		expect(next).not.toBe(original);
		expect(original).toHaveLength(1);
		expect(next).toHaveLength(2);
		expect(next[1]).toMatchObject({
			role: "custom",
			customType: "deck-session-topology-context",
			content: "focus text",
			display: false,
			attribution: "agent",
		});
	});

	test("documents the provisional injected message shape", () => {
		const next = appendTopologyContextMessage([user("hello")], "focus text");
		expect(next[1]).toEqual(expect.objectContaining({ role: "custom", display: false }));
		// Production implementation must additionally verify this custom-role shape survives OMP's provider conversion.
		// If conversion rejects it, replace this helper with a supported transient instruction shape before enabling the extension.
	});
});

test("replaceTopologyContext keeps last N user turns and replaces earlier messages", () => {
	const msgs = [
		user("old 1"), assistant("old reply 1"),
		user("old 2"), assistant("old reply 2"),
		user("recent 1"), assistant("recent reply 1"),
		tool("tool result"),
		user("recent 2"), assistant("recent reply 2"),
	];
	const result = replaceTopologyContext(msgs, "focus text", 3);
	expect(result[0]).toMatchObject({ role: "custom", customType: "deck-session-topology-context", content: "focus text" });
	expect(result[1]).toMatchObject({ role: "user" });
	expect(result[1]).toHaveProperty("content", [{ type: "text", text: "old 2" }]);
	expect(result[2]).toMatchObject({ role: "assistant" });
	expect(result[3]).toMatchObject({ role: "user" });
	expect(result[3]).toHaveProperty("content", [{ type: "text", text: "recent 1" }]);
	expect(result[4]).toMatchObject({ role: "assistant" });
	expect(result[5]).toMatchObject({ role: "tool" });
	expect(result[6]).toMatchObject({ role: "user" });
	expect(result[6]).toHaveProperty("content", [{ type: "text", text: "recent 2" }]);
	expect(result[7]).toMatchObject({ role: "assistant" });
	expect(result).toHaveLength(8);
});

test("replaceTopologyContext keeps only N recent user turns", () => {
	const msgs = [
		user("q1"), assistant("a1"),
		user("q2"), assistant("a2"),
		user("q3"), assistant("a3"),
		user("q4"), assistant("a4"),
	];
	const result = replaceTopologyContext(msgs, "focus", 2);
	expect(result).toHaveLength(5);
	expect(result[0]).toMatchObject({ role: "custom" });
	expect(result[1]).toHaveProperty("content", [{ type: "text", text: "q3" }]);
});

test("replaceTopologyContext returns only focus when no messages", () => {
	const result = replaceTopologyContext([], "focus", 3);
	expect(result).toHaveLength(1);
	expect(result[0]).toMatchObject({ role: "custom", content: "focus" });
});

test("replaceTopologyContext does not mutate input", () => {
	const original = [user("hello")];
	const frozen = [...original];
	replaceTopologyContext(original, "focus", 3);
	expect(original).toEqual(frozen);
});


// ─── A5: HTTP evidence integration — proves topology focus reaches provider ─

import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/** Fake pi that captures event handlers. */
function fakePi(): {
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	handlers: Record<string, (...args: unknown[]) => unknown>;
} {
	const raw: Record<string, Array<(...args: unknown[]) => unknown>> = {};
	return {
		on(event, handler) {
			(raw[event] ??= []).push(handler);
		},
		handlers: new Proxy(raw, {
			get(target, key) {
				const arr = target[key as string];
				return arr?.[0];
			},
		}),
	};
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function requestBody(init?: RequestInit): unknown {
	return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

function readMessages(value: unknown): unknown[] | null {
	if (!value || typeof value !== "object" || !("messages" in value)) return null;
	return Array.isArray(value.messages) ? value.messages : null;
}

describe("A5: HTTP evidence integration — topology focus reaches provider payload", () => {
	const previousEnabled = process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED;
	const previousApiBase = process.env.OMP_DECK_API_BASE;

	beforeEach(() => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		process.env.OMP_DECK_API_BASE = "http://127.0.0.1:8787/api";
	});

	afterAll(() => {
		if (previousEnabled === undefined) delete process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED;
		else process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = previousEnabled;
		if (previousApiBase === undefined) delete process.env.OMP_DECK_API_BASE;
		else process.env.OMP_DECK_API_BASE = previousApiBase;
	});

	test("context hook creates evidence before provider hook updates the DB event", async () => {
		const focusText = "<session_topology_subgraph>\ngoal: fix-bug\naction: write-test\n</session_topology_subgraph>";
		const evidencePosts: Array<{ url: string; body: unknown }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = requestUrl(input);
			if (url.includes("/context-focus")) return jsonResponse({ focus: focusText });
			if (init?.method === "POST") {
				evidencePosts.push({ url, body: requestBody(init) });
				if (url.endsWith("/context-evidence")) return jsonResponse({ eventId: "evt-http-a5" }, 201);
				return jsonResponse({ ok: true });
			}
			return jsonResponse({ error: "unexpected request" }, 500);
		};

		try {
			const pi = fakePi();
			const mod = await import("./index.ts");
			mod.default(pi as { on: (event: string, handler: (...args: unknown[]) => unknown) => void });

			const contextHandler = pi.handlers.context;
			if (typeof contextHandler !== "function") throw new Error("context handler not registered");
			const result = await contextHandler(
				{ messages: [{ role: "user", content: [{ type: "text", text: "fix that bug" }] }] },
				{
					sessionManager: { getSessionId: () => "test-session-a5" },
					getContextUsage: () => ({ tokens: 5000, percent: 0.4 }),
				},
			);

			const messages = readMessages(result);
			expect(messages).not.toBeNull();
			if (!messages) return;
			expect(messages[0]).toMatchObject({
				role: "custom",
				customType: "deck-session-topology-context",
				content: focusText,
			});

			const mock = createMockModel({ handler: (ctx) => ({ content: [`received ${ctx.messages.length} msgs`] }) });
			mock.stream(mock.model, { messages } as Parameters<typeof mock.stream>[1]);
			expect(mock.calls).toHaveLength(1);
			const providerContext = mock.calls[0]?.context;
			expect(providerContext?.messages[0]).toMatchObject({ content: focusText });

			const providerHandler = pi.handlers.before_provider_request;
			if (typeof providerHandler !== "function") throw new Error("before_provider_request handler not registered");
			await providerHandler(
				{ payload: providerContext },
				{ sessionManager: { getSessionId: () => "test-session-a5" } },
			);

			expect(evidencePosts.map(({ body }) => body)).toEqual([
				expect.objectContaining({ status: "constructed", mechanism: "context_hook" }),
				{ status: "handler_returned" },
				{ status: "provider_payload_observed" },
			]);
			expect(evidencePosts.map(({ url }) => url)).toEqual([
				"http://127.0.0.1:8787/api/sessions/test-session-a5/context-evidence",
				"http://127.0.0.1:8787/api/sessions/test-session-a5/context-evidence/evt-http-a5",
				"http://127.0.0.1:8787/api/sessions/test-session-a5/context-evidence/evt-http-a5",
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("failed focus fetch posts valid non-empty failure evidence", async () => {
		const evidenceBodies: unknown[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = requestUrl(input);
			if (url.includes("/context-focus")) return jsonResponse({ error: "unavailable" }, 503);
			if (init?.method === "POST") {
				evidenceBodies.push(requestBody(init));
				return jsonResponse({ eventId: "evt-failed-focus" }, 201);
			}
			return jsonResponse({ error: "unexpected request" }, 500);
		};

		try {
			const pi = fakePi();
			const mod = await import("./index.ts");
			mod.default(pi as { on: (event: string, handler: (...args: unknown[]) => unknown) => void });
			const contextHandler = pi.handlers.context;
			if (typeof contextHandler !== "function") throw new Error("context handler not registered");
			const result = await contextHandler(
				{ messages: [{ role: "user", content: [{ type: "text", text: "failure sentinel query" }] }] },
				{ sessionManager: { getSessionId: () => "failed-session" }, getContextUsage: () => null },
			);

			expect(result).toBeUndefined();
			expect(evidenceBodies).toHaveLength(1);
			expect(evidenceBodies[0]).toMatchObject({
				status: "failed",
				mechanism: "context_hook",
				estimatedFocusTokens: 0,
			});
			if (!evidenceBodies[0] || typeof evidenceBodies[0] !== "object") return;
			expect("focusHash" in evidenceBodies[0] && typeof evidenceBodies[0].focusHash === "string" && evidenceBodies[0].focusHash.length > 0).toBe(true);
			expect("focusPreview" in evidenceBodies[0] && typeof evidenceBodies[0].focusPreview === "string" && evidenceBodies[0].focusPreview.length > 0).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not invent an event id when the evidence create POST fails", async () => {
		const focusText = "<session_topology_subgraph>race-free</session_topology_subgraph>";
		const evidenceUrls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = requestUrl(input);
			if (url.includes("/context-focus")) return jsonResponse({ focus: focusText });
			if (init?.method === "POST") {
				evidenceUrls.push(url);
				return jsonResponse({ error: "create failed" }, 500);
			}
			return jsonResponse({ error: "unexpected request" }, 500);
		};

		try {
			const pi = fakePi();
			const mod = await import("./index.ts");
			mod.default(pi as { on: (event: string, handler: (...args: unknown[]) => unknown) => void });
			const contextHandler = pi.handlers.context;
			if (typeof contextHandler !== "function") throw new Error("context handler not registered");
			await contextHandler(
				{ messages: [{ role: "user", content: [{ type: "text", text: "race free" }] }] },
				{ sessionManager: { getSessionId: () => "race-session" }, getContextUsage: () => null },
			);
			const providerHandler = pi.handlers.before_provider_request;
			if (typeof providerHandler !== "function") throw new Error("before_provider_request handler not registered");
			await providerHandler(
				{ payload: { messages: [{ content: focusText }] } },
				{ sessionManager: { getSessionId: () => "race-session" } },
			);

			expect(evidenceUrls).toEqual([
				"http://127.0.0.1:8787/api/sessions/race-session/context-evidence",
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("provider hook ignores events without a payload", async () => {
		const focusText = "<session_topology_subgraph>missing-payload</session_topology_subgraph>";
		const evidenceUrls: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = requestUrl(input);
			if (url.includes("/context-focus")) return jsonResponse({ focus: focusText });
			if (init?.method === "POST") {
				evidenceUrls.push(url);
				if (url.endsWith("/context-evidence")) return jsonResponse({ eventId: "evt-missing-payload" }, 201);
				return jsonResponse({ ok: true });
			}
			return jsonResponse({ error: "unexpected request" }, 500);
		};
		try {
			const pi = fakePi();
			const mod = await import("./index.ts");
			mod.default(pi as { on: (event: string, handler: (...args: unknown[]) => unknown) => void });
			const contextHandler = pi.handlers.context;
			if (typeof contextHandler !== "function") throw new Error("context handler not registered");
			await contextHandler(
				{ messages: [{ role: "user", content: [{ type: "text", text: "missing payload" }] }] },
				{ sessionManager: { getSessionId: () => "missing-payload-session" }, getContextUsage: () => null },
			);
			const providerHandler = pi.handlers.before_provider_request;
			if (typeof providerHandler !== "function") throw new Error("before_provider_request handler not registered");
			await expect(providerHandler(
				{},
				{ sessionManager: { getSessionId: () => "missing-payload-session" } },
			)).resolves.toBeUndefined();
			expect(evidenceUrls).toEqual([
				"http://127.0.0.1:8787/api/sessions/missing-payload-session/context-evidence",
				"http://127.0.0.1:8787/api/sessions/missing-payload-session/context-evidence/evt-missing-payload",
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("provider hook updates only the current session when focus text matches multiple pending events", async () => {
		const focusText = "<session_topology_subgraph>shared-focus</session_topology_subgraph>";
		const updateUrls: string[] = [];
		let createCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = requestUrl(input);
			if (url.includes("/context-focus")) return jsonResponse({ focus: focusText });
			if (init?.method === "POST") {
				if (url.endsWith("/context-evidence")) {
					createCount++;
					return jsonResponse({ eventId: `evt-current-${createCount}` }, 201);
				}
				const body = requestBody(init);
				if (body && typeof body === "object" && "status" in body && body.status === "provider_payload_observed") {
					updateUrls.push(url);
				}
				return jsonResponse({ ok: true });
			}
			return jsonResponse({ error: "unexpected request" }, 500);
		};

		try {
			const pi = fakePi();
			const mod = await import("./index.ts");
			mod.default(pi as { on: (event: string, handler: (...args: unknown[]) => unknown) => void });
			const contextHandler = pi.handlers.context;
			if (typeof contextHandler !== "function") throw new Error("context handler not registered");
			for (const sessionId of ["other-session", "current-session"]) {
				await contextHandler(
					{ messages: [{ role: "user", content: [{ type: "text", text: "shared focus" }] }] },
					{ sessionManager: { getSessionId: () => sessionId }, getContextUsage: () => null },
				);
			}

			const providerHandler = pi.handlers.before_provider_request;
			if (typeof providerHandler !== "function") throw new Error("before_provider_request handler not registered");
			await providerHandler(
				{ payload: { messages: [{ content: focusText }] } },
				{ sessionManager: { getSessionId: () => "current-session" } },
			);

			expect(updateUrls).toEqual([
				"http://127.0.0.1:8787/api/sessions/current-session/context-evidence/evt-current-2",
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("evidence helpers reject non-loopback API bases without fetching", async () => {
		const originalFetch = globalThis.fetch;
		let fetchCount = 0;
		globalThis.fetch = async () => {
			fetchCount++;
			return jsonResponse({ eventId: "should-not-exist" }, 201);
		};

		try {
			const mod = await import("./index.ts");
			const createHelper = "createContextEvidence" in mod ? mod.createContextEvidence : undefined;
			const updateHelper = "updateContextEvidence" in mod ? mod.updateContextEvidence : undefined;
			expect(typeof createHelper).toBe("function");
			expect(typeof updateHelper).toBe("function");
			if (typeof createHelper !== "function" || typeof updateHelper !== "function") return;

			const eventId = await createHelper(
				"https://example.com/api",
				"session",
				{ status: "constructed", mechanism: "context_hook", focusHash: "hash", focusPreview: "preview" },
				1500,
			);
			const updated = await updateHelper(
				"https://example.com/api",
				"session",
				"event",
				{ status: "provider_payload_observed" },
				1500,
			);

			expect(eventId).toBeNull();
			expect(updated).toBe(false);
			expect(fetchCount).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
