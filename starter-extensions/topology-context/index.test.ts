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


// ─── A5: Mock provider integration — proves topology focus reaches provider ──

import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { CreateContextEvidenceRequest } from "@omp-deck/protocol";
import {
	setEvidenceRecorder,
	resetEvidenceRecorder,
	type EvidenceRecorder,
} from "./index.ts";

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

/** Fake evidence recorder for in-test inspection. */
function fakeRecorder(): EvidenceRecorder & { transitions: Array<{ eventId: string; status: string }> } {
	const state = new Map<string, string>();
	const transitions: Array<{ eventId: string; status: string }> = [];
	return {
		record(params: CreateContextEvidenceRequest): string {
			const eventId = params.focusHash || crypto.randomUUID();
			state.set(eventId, params.status);
			transitions.push({ eventId, status: params.status });
			return eventId;
		},
		update(eventId: string, updates: { status: string; beforeTokens?: number | null; beforePercent?: number | null }) {
			const prev = state.get(eventId);
			transitions.push({ eventId, status: updates.status });
			// Still track current status for verification
			state.set(eventId, updates.status);
		},
		transitions,
	};
}

// Narrowing guards instead of inline casts
function isAsyncFn(fn: unknown): fn is (...args: unknown[]) => Promise<unknown> {
	return typeof fn === "function";
}

function isFn(fn: unknown): fn is (...args: unknown[]) => unknown {
	return typeof fn === "function";
}

describe("A5: mock provider integration — topology focus reaches provider payload", () => {
	const prevEnv = { ...process.env };

	beforeAll(() => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		process.env.OMP_DECK_API_BASE = "http://127.0.0.1:8787/api";
	});

	afterAll(() => {
		resetEvidenceRecorder();
		Object.assign(process.env, prevEnv);
	});

	test("context hook → mock provider → before_provider_request full lifecycle", async () => {
		const focusText = "<session_topology_subgraph>\ngoal: fix-bug\naction: write-test\n</session_topology_subgraph>";

		// Mock fetch to return the focus response
		const origFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ focus: focusText }),
			})) as unknown as typeof fetch;

		const rec = fakeRecorder();
		setEvidenceRecorder(rec);

		try {
			const pi = fakePi();
			const mod = await import("./index.ts");
			mod.default(pi as { on: (event: string, handler: (...args: unknown[]) => unknown) => void });

			// Phase 1: Fire context hook → get replaced messages
			const ctxHandler = pi.handlers["context"];
			if (!isAsyncFn(ctxHandler)) throw new Error("context handler not registered");

			const result = await ctxHandler(
				{ messages: [{ role: "user", content: [{ type: "text", text: "fix that bug" }] }] },
				{
					sessionManager: { getSessionId: () => "test-session-a5" },
					getContextUsage: () => ({ tokens: 5000, percent: 0.4 }),
				},
			);

			// Verify context hook returned replaced messages with focus injected
			expect(result).toBeDefined();
			const ctxResult = result as { messages: Array<{ role: string; content: unknown }> } | undefined;
			expect(ctxResult).toBeDefined();
			if (!ctxResult) return;
			expect(ctxResult.messages[0]).toMatchObject({
				role: "custom",
				customType: "deck-session-topology-context",
				content: focusText,
			});

			// Phase 2: Create mock model and feed it the replaced messages
			const mock = createMockModel({
				handler: (ctx) => ({ content: [`received ${ctx.messages.length} msgs`] }),
			});

			// Record a call by streaming the messages through the mock
			mock.stream(mock.model, {
				messages: ctxResult.messages as Array<{ role: string; content: unknown }>,
			} as Parameters<typeof mock.stream>[1]);

			// Verify the mock captured the call with focus text
			expect(mock.calls.length).toBe(1);
			const mockCall = mock.calls[0];
			expect(mockCall).toBeDefined();
			const mockCtx = mockCall!.context;
			expect(mockCtx).toBeDefined();
			// Focus text should be present in the messages sent to provider
			const firstMsg = mockCtx!.messages[0];
			expect(firstMsg).toBeDefined();
			if (firstMsg && typeof firstMsg === "object" && "content" in firstMsg) {
				expect(String(firstMsg.content)).toBe(focusText);
			}

			// Phase 3: Fire before_provider_request with the mock call's context
			const providerHook = pi.handlers["before_provider_request"];
			if (!isFn(providerHook)) throw new Error("before_provider_request handler not registered");
			providerHook({ payload: mockCtx });

			// Verify evidence status transitioned to provider_payload_observed
			const observed = rec.transitions.find((e) => e.status === "provider_payload_observed");
			expect(observed).toBeDefined();

			// Evidence lifecycle: constructed → handler_returned → provider_payload_observed
			const constructed = rec.transitions.find((e) => e.status === "constructed");
			expect(constructed).toBeDefined();
			const returned = rec.transitions.find((e) => e.status === "handler_returned");
			expect(returned).toBeDefined();
			if (constructed && observed) {
				expect(observed.eventId).toBe(constructed.eventId);
			}
		} finally {
			globalThis.fetch = origFetch;
			resetEvidenceRecorder();
		}
	});
});
