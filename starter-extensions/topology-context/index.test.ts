import { describe, expect, test } from "bun:test";

import {
	appendTopologyContextMessage,
	buildContextFocusUrl,
	extractLatestUserText,
	isLoopbackApiBase,
	normalizeDeckApiBase,
	parseFocusResponse,
	readBoundedEnvInt,
	shouldActivate,
} from "./index.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] });

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
