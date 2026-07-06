# Always-On Topology Context Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off, deck-activated OMP starter extension that injects the existing clean Session Context Topology focus into eligible prompt contexts before compact-triggered replacement is needed.

**Architecture:** This is the next phase after `2026-07-02-session-context-topology.md`, `2026-07-03-query-time-topology-external-rerank.md`, and `2026-07-04-topology-rerank-rpc-contract.md`. Keep the shipped 15% compact-triggered replacement path unchanged. Add a server endpoint that reuses `getStoredQueryTopologyFocus()`, a deck-managed settings/status surface, and a repo-shipped OMP starter extension that fetches focus over loopback HTTP using `ctx.sessionManager.getSessionId()` and returns a replacement `messages` array from the OMP `context` hook.

**Tech Stack:** TypeScript, Bun test, Hono, React Settings UI, existing OMP extension runtime, existing `starter-extensions/` installer, Session Context Topology retrieval/rerank helpers.

---

## Grounded current state

Current shipped topology injection exists only in the compact-triggered path:

- `apps/server/src/session-context.ts:463-507` exposes async `getStoredQueryTopologyFocus()` that reads the stored top-200 graph, runs query-time retrieval, optionally uses the injected rerank seam, and renders clean `<session_topology_subgraph>` focus text.
- `apps/server/src/bridge/in-process.ts:927-945` calls that getter only from `maybeAutoCompactContext()` when `shouldReplaceContext(percent)` is true.
- `apps/server/src/bridge/rpc.ts:585-603` does the same before sending RPC `compact`.
- `apps/server/src/session-context.ts:558-604` defines the shipped threshold: `CONTEXT_REPLACEMENT_THRESHOLD_PERCENT = 15` and `shouldReplaceContext(percent)` uses `percent >= thresholdPercent`.

This plan adds opt-in always-on, query-time topology context **before** the 15% compact threshold. It must not replace or weaken the existing compact path.

## Existing plan stack positioning

This plan is Phase 3, not a replacement for earlier work:

1. `2026-07-02-session-context-topology.md` built deck-owned `session_context_*` persistence, deterministic extraction, context pack/graph APIs, and the context-pack panel.
2. `2026-07-03-query-time-topology-external-rerank.md` made query-time focus async and added the strict optional rerank seam while preserving local retrieval fallback.
3. `2026-07-04-topology-rerank-rpc-contract.md` defined the missing RPC/model-role contract for a future real external reranker.
4. This plan exposes the already-rendered focus string to an OMP extension and injects it into eligible pre-LLM message conversions.

## Superseded stale background

`docs/superpowers/specs/2026-07-03-context-pack-replacement-design.md` is stale/conflicted for trigger semantics and mechanism:

- It says 15% at lines 5-6, but also says 50% at lines 10 and 52.
- Shipped code uses 15% in `session-context.ts:558-604`.
- It suggests in-process bridge `transformContext` plus RPC `compact`; current code already shipped compact-triggered replacement and this plan chooses an OMP starter extension for always-on injection.

Do not use that spec as source-of-truth for thresholds or implementation mechanism.

## Design decisions

### Use an OMP starter extension, not a deck bridge prompt hack

Deck's `SessionHandle` contract exposes `prompt()` and `compact()` (`apps/server/src/bridge/types.ts:104-156`), not a clean pre-dispatch message-transform seam. Deck-side levers are prompt rewriting, synthetic follow-ups, or compact-style replacement; all are worse than using the upstream extension hook.

The repo already has the distribution/control pattern needed for an extension:

- `apps/server/src/starter-extensions.ts:35-95` copies repo-shipped extensions from `starter-extensions/` into `~/.omp/agent/extensions/<name>/` on boot.
- The installer is idempotent and never overwrites an existing installed copy. Once copied, the installed extension is user-owned.
- `maintenance-gate` already uses this model and has a deck-managed control plane via `orientation-store.ts`, `routes-orientation.ts`, `orientation-api.ts`, and `SettingsView.tsx`.

### Keep extension default-off and deck-activated

Starter extensions ride on top of the SDK and can load for every OMP session, not just deck sessions. Therefore this extension must be inert unless all activation gates pass:

1. `OMP_DECK_TOPOLOGY_CONTEXT_ENABLED` is truthy.
2. `OMP_DECK_API_BASE` is present and parses as a loopback/local API URL.
3. `ctx.sessionManager.getSessionId()` returns a non-empty id.
4. The latest model-bound message is a normal user text message.

User-facing enablement defaults to off. Settings may turn it on, but the extension still skips unless the deck API marker and session id are available. This mirrors the maintenance-gate pattern: global installed extension, deck-specific activation contract.

### Fetch topology through deck HTTP

A starter extension has `ctx.sessionManager.getSessionId()`, `getSessionFile()`, and branch/session state, but it does not have direct access to deck's SQLite/session-context service. The clean integration boundary is loopback HTTP:

```text
GET ${OMP_DECK_API_BASE}/sessions/:sessionId/context-focus?q=<latest user text>&contextPercent=<optional>
```

`OMP_DECK_API_BASE` is a shared deck env knob, not a topology-specific endpoint variable. The extension should normalize configured values so both `http://127.0.0.1:8787` and `http://127.0.0.1:8787/api` work. For activation, however, **do not silently invent a base URL when the env var is missing**; missing `OMP_DECK_API_BASE` means non-deck or unproven environment, so skip injection. The settings/control plane may write this shared env key when the user enables topology injection and accepts the displayed default.

### Reuse existing focus rendering server-side

The extension must not re-render `SessionContextPackResponse`. `/context-pack` returns verbose typed pack objects, while `getStoredQueryTopologyFocus()` already renders the exact clean JSON focus used by compact replacement and strips internal ranking/scoring fields from model-facing text. Add a focused server endpoint that returns this string.

### Context hook caveats

The upstream OMP `context` hook is a shared pre-LLM-conversion seam. It is non-persistent when handlers return a replacement messages array, but it is not strictly “main user turn only”:

- `ContextEvent` carries only `{ type, messages }`.
- There is no first-class caller-origin flag.
- The same pre-LLM conversion path can be used by side-channel/export paths.
- The exact injected message role/shape must be proven against OMP's conversion pipeline before production uses it. This plan starts with a compatibility test; if `role: "custom"` is not accepted provider-bound, use the smallest already-supported non-user instruction shape that preserves transcript non-persistence.

Therefore v1 uses conservative message-shape gating. If exact caller discrimination becomes required, add upstream origin metadata in a later plan.

### Avoid public `sendMessage(..., deliverAs: "nextTurn")`

Do not use public `sendMessage`/`sendCustomMessage` for steady-state topology memory. The private hidden queue is `#pendingNextTurnMessages`, but public idle `sendCustomMessage(..., { deliverAs: "nextTurn" })` can append to agent state and persist via `appendCustomMessageEntry`. Always-on topology memory must use the `context` replacement-array hook instead.

---

## File responsibilities

Create:

- `starter-extensions/topology-context/index.ts`
  - OMP extension using `pi.on("context", ...)`.
  - Exports pure helpers for tests.
  - Checks deck activation gates.
  - Extracts latest user text from `event.messages`.
  - Uses `ctx.sessionManager.getSessionId()` and loopback HTTP to fetch server-rendered focus.
  - Returns a replacement `messages` array with one transient, `display: false` topology context entry appended; it must not call any persistence API.
- `starter-extensions/topology-context/index.test.ts`
  - Unit tests for URL normalization, activation gates, query extraction, focus-response parsing, replacement-array construction, and injected message-shape compatibility.

Modify:

- `packages/protocol/src/index.ts`
  - Add `SessionContextFocusResponse`.
  - Add `TopologyContextInjectionState` and `UpdateTopologyContextInjectionRequest`.
- `apps/server/src/routes-session-context.ts`
  - Add `GET /sessions/:id/context-focus` using the existing `resolveSessionContextTarget()` and `getStoredQueryTopologyFocus()`.
- `apps/server/src/routes-session-context.test.ts`
  - Add endpoint tests for active/persisted sessions, empty stored graph, missing session, and clean focus invariants.
- `apps/server/src/orientation-store.ts`
  - Add topology-context injection env keys, defaults, installed/bundled extension status, hash comparison, and read function.
- `apps/server/src/routes-orientation.ts`
  - Add `GET/PUT /orientation/topology-context-injection`.
- `apps/server/src/env-schema.ts`
  - Add env schema entries for topology-context injection settings.
- `apps/web/src/lib/orientation-api.ts`
  - Add `getTopologyContextInjection()` and `putTopologyContextInjection()`.
- `apps/web/src/views/SettingsView.tsx`
  - Add a settings card analogous to `MaintenanceGateCard`.
- Optional if no existing test covers installer behavior: `apps/server/src/starter-extensions.test.ts`
  - Prove the new source dir is copied when missing and existing installed copies are not overwritten.

Do not modify:

- `apps/server/src/bridge/in-process.ts` compact logic.
- `apps/server/src/bridge/rpc.ts` compact logic.
- `apps/server/src/session-context.ts` retrieval/rerank behavior except to export a named response helper if route tests require it.
- Mnemopi or Memory Cockpit code.

---

### Task 1: Add protocol types

**Files:**

- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing type usage through later tests**

Task 2 route tests must import:

```ts
import type { SessionContextFocusResponse } from "@omp-deck/protocol";
```

Task 5 orientation tests must import or use:

```ts
import type {
	TopologyContextInjectionState,
	UpdateTopologyContextInjectionRequest,
} from "@omp-deck/protocol";
```

Run after those tests exist:

```bash
bun run --filter '@omp-deck/server' typecheck
```

Expected: FAIL with missing exported members.

- [ ] **Step 2: Add protocol types**

Add near the existing Session Context Topology protocol section:

```ts
export interface SessionContextFocusResponse {
	sessionId: string;
	query: string;
	focus: string;
	nodeCount: number;
	edgeCount: number;
	truncated: boolean;
	emptyReason?: "session_not_built" | "no_relevant_context";
}
```

Add near maintenance/orientation types:

```ts
export interface TopologyContextInjectionState {
	enabled: boolean;
	enabledRaw: string | null;
	enabledSource: GateValueSource;
	active: boolean;
	inactiveReason?: "disabled" | "missing_api_base" | "invalid_api_base" | "extension_missing";
	apiBase: {
		value: string;
		default: string;
		rawValue: string | null;
		source: GateValueSource;
	};
	maxFocusChars: GateKnob;
	timeoutMs: GateKnob;
	installedExtensionPresent: boolean;
	installedExtensionPath: string;
	bundledExtensionPresent: boolean;
	bundledExtensionPath: string;
	installedHash: string | null;
	bundledHash: string | null;
	installStatus: "missing" | "current" | "user-owned-or-outdated";
}

export interface UpdateTopologyContextInjectionRequest {
	enabled?: boolean;
	apiBase?: string | null;
	maxFocusChars?: number | null;
	timeoutMs?: number | null;
}
```

Use the existing `GateValueSource` and `GateKnob` types.

- [ ] **Step 3: Run protocol consumer typecheck**

Run:

```bash
bun run --filter '@omp-deck/server' typecheck
```

Expected after Tasks 2 and 5 implementations: PASS.

---

### Task 2: Add server-rendered context focus endpoint

**Files:**

- Modify: `apps/server/src/routes-session-context.test.ts`
- Modify: `apps/server/src/routes-session-context.ts`

- [ ] **Step 1: Write failing route tests**

Add to `apps/server/src/routes-session-context.test.ts`:

```ts
describe("GET /sessions/:id/context-focus", () => {
	test("returns rendered clean topology focus for active session after rebuild", async () => {
		const { app } = setupSession();
		await app.request("/sessions/s1/context/rebuild", { method: "POST" });

		const res = await app.request("/sessions/s1/context-focus?q=context&contextPercent=7");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionContextFocusResponse;
		expect(body.sessionId).toBe("s1");
		expect(body.query).toBe("context");
		expect(body.focus).toContain("<session_topology_subgraph>");
		expect(body.focus).toContain('"query":"context"');
		expect(body.nodeCount).toBeGreaterThan(0);
		expect(body.edgeCount).toBeGreaterThanOrEqual(0);
		expect(body.emptyReason).toBeUndefined();
		expect(body.focus).not.toContain('"importance"');
		expect(body.focus).not.toContain('"weight"');
		expect(body.focus).not.toContain('"confidence"');
		expect(body.focus).not.toContain('"relevance"');
	});

	test("returns rendered focus for persisted session after rebuild", async () => {
		const { app } = setupPersistedSession();
		await app.request("/sessions/persisted-s1/context/rebuild", { method: "POST" });

		const res = await app.request("/sessions/persisted-s1/context-focus?q=memory");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionContextFocusResponse;
		expect(body.sessionId).toBe("persisted-s1");
		expect(body.query).toBe("memory");
		expect(body.focus).toContain("<session_topology_subgraph>");
	});

	test("returns empty focus for existing unbuilt session", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const app = buildSessionContextRouter(makeBridge(undefined, ["persisted-s1"]));

		const res = await app.request("/sessions/persisted-s1/context-focus?q=context");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionContextFocusResponse;
		expect(body).toEqual({
			sessionId: "persisted-s1",
			query: "context",
			focus: "",
			nodeCount: 0,
			edgeCount: 0,
			truncated: false,
			emptyReason: "session_not_built",
		});
	});

	test("returns 404 when session is missing", async () => {
		const app = buildSessionContextRouter(makeBridge(undefined));
		const res = await app.request("/sessions/missing/context-focus?q=context");
		expect(res.status).toBe(404);
	});
});
```

Add `SessionContextFocusResponse` to the existing protocol type import.

- [ ] **Step 2: Run the route tests and verify failure**

Run:

```bash
bun test apps/server/src/routes-session-context.test.ts
```

Expected: FAIL because `/context-focus` and/or the protocol type are missing.

- [ ] **Step 3: Implement endpoint**

In `apps/server/src/routes-session-context.ts`, add a route after `/context-pack`:

```ts
app.get("/sessions/:id/context-focus", async (c) => {
	const id = c.req.param("id");
	const query = c.req.query("q") ?? "";
	const rawPercent = c.req.query("contextPercent");
	const parsedPercent = rawPercent === undefined ? null : Number(rawPercent);
	try {
		const target = await resolveSessionContextTarget(bridge, id);
		if (!target.exists) return c.json({ error: "session not found" }, 404);
		const graph = getSessionContextGraph(id, 200);
		if (graph.nodes.length === 0) {
			return c.json({
				sessionId: id,
				query,
				focus: "",
				nodeCount: 0,
				edgeCount: 0,
				truncated: false,
				emptyReason: "session_not_built",
			} satisfies SessionContextFocusResponse);
		}
		const focus = await getStoredQueryTopologyFocus({
			sessionId: id,
			query,
			contextPercent: Number.isFinite(parsedPercent) ? parsedPercent : null,
		});
		return c.json({
			sessionId: id,
			query,
			focus,
			nodeCount: graph.totalNodes,
			edgeCount: graph.edges.length,
			truncated: graph.truncated,
			...(focus ? {} : { emptyReason: "no_relevant_context" as const }),
		} satisfies SessionContextFocusResponse);
	} catch (err) {
		log.error("context focus failed", err);
		return c.json({ error: String((err as Error).message ?? err) }, 500);
	}
});
```

Keep the endpoint read-only. It reads stored DB topology and never auto-rebuilds.

- [ ] **Step 4: Run focused route tests**

Run:

```bash
bun test apps/server/src/routes-session-context.test.ts
```

Expected: PASS.

---

### Task 3: Add topology-context extension tests

**Files:**

- Create: `starter-extensions/topology-context/index.test.ts`
- Create later in Task 4: `starter-extensions/topology-context/index.ts`
- Add compatibility coverage against OMP message conversion if a local exported converter/test seam is available; otherwise write the helper-level shape test and keep the production implementation behind an explicit manual smoke item in Task 8.

- [ ] **Step 1: Write failing helper tests**

Create `starter-extensions/topology-context/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
	appendTopologyContextMessage,
	buildContextFocusUrl,
	extractLatestUserText,
	isLoopbackApiBase,
	normalizeDeckApiBase,
	parseFocusResponse,
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
		expect(isLoopbackApiBase("https://example.com/api")).toBe(false);
		expect(isLoopbackApiBase("not a url")).toBe(false);
	});

	test("activates only when enabled and deck API base is present", () => {
		expect(shouldActivate({ OMP_DECK_TOPOLOGY_CONTEXT_ENABLED: "1", OMP_DECK_API_BASE: "http://127.0.0.1:8787/api" })).toBe(true);
		expect(shouldActivate({ OMP_DECK_API_BASE: "http://127.0.0.1:8787/api" })).toBe(false);
		expect(shouldActivate({ OMP_DECK_TOPOLOGY_CONTEXT_ENABLED: "1" })).toBe(false);
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
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test starter-extensions/topology-context/index.test.ts
```

Expected: FAIL because the extension file is missing.

---

### Task 4: Implement the topology-context starter extension

**Files:**

- Create: `starter-extensions/topology-context/index.ts`

- [ ] **Step 1: Create extension implementation**

Create `starter-extensions/topology-context/index.ts`:

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const CUSTOM_TYPE = "deck-session-topology-context";

interface TextPart { type: "text"; text: string }
interface MessageLike { role?: string; content?: string | TextPart[]; customType?: string }

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
		return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
	} catch {
		return false;
	}
}

export function shouldActivate(env: Record<string, string | undefined>): boolean {
	const enabled = ["1", "true", "yes", "on"].includes((env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED ?? "").trim().toLowerCase());
	if (!enabled) return false;
	return isLoopbackApiBase(normalizeDeckApiBase(env.OMP_DECK_API_BASE));
}

export function buildContextFocusUrl(base: string, sessionId: string, query: string, contextPercent?: number): string {
	const normalized = normalizeDeckApiBase(base);
	if (!normalized) throw new Error("missing OMP_DECK_API_BASE");
	const url = new URL(`${normalized}/sessions/${encodeURIComponent(sessionId)}/context-focus`);
	url.searchParams.set("q", query);
	if (typeof contextPercent === "number" && Number.isFinite(contextPercent)) url.searchParams.set("contextPercent", String(contextPercent));
	return url.toString();
}

export function extractLatestUserText(messages: MessageLike[]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content.trim() || null;
	if (!Array.isArray(last.content)) return null;
	const text = last.content.filter((part): part is TextPart => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
	return text || null;
}

export function parseFocusResponse(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const focus = (value as { focus?: unknown }).focus;
	return typeof focus === "string" ? focus : null;
}

export function appendTopologyContextMessage<T extends MessageLike>(messages: T[], focus: string): Array<T | MessageLike> {
	return [...messages, { role: "custom", customType: CUSTOM_TYPE, content: focus, display: false, attribution: "agent", timestamp: Date.now() }];
}

function envInt(name: string, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	if (!Number.isFinite(parsed)) return fallback;
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
		const sessionId = ctx.sessionManager.getSessionId?.();
		if (!sessionId) return undefined;
		const query = extractLatestUserText(event.messages as MessageLike[]);
		if (!query) return undefined;
		const apiBase = normalizeDeckApiBase(process.env.OMP_DECK_API_BASE);
		if (!apiBase) return undefined;
		const usage = ctx.getContextUsage?.();
		const contextPercent = typeof usage?.percent === "number" ? usage.percent : undefined;
		const url = buildContextFocusUrl(apiBase, sessionId, query, contextPercent);
		const timeoutMs = envInt("OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS", 1500, 100, 30_000);
		const maxFocusChars = envInt("OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS", 12_000, 1000, 50_000);
		const focus = await fetchFocus(url, timeoutMs);
		if (!focus) return undefined;
		const bounded = focus.length > maxFocusChars ? `${focus.slice(0, maxFocusChars)}\n[truncated]` : focus;
		return { messages: appendTopologyContextMessage(event.messages as MessageLike[], bounded) as never };
	});
}
```

Implementation invariants:

- Return a replacement `messages` array; do not mutate `event.messages` in place.
- Use HTTP only; do not import deck DB or server modules from the installed extension.
- Skip silently on missing enable flag, missing/invalid API base, fetch failure, missing session id, non-user tail, or empty focus.
- Treat the `role: "custom"` injected entry as provisional until a compatibility test or manual smoke proves OMP converts it into provider-bound context without persisting it. If it fails, switch to a supported transient instruction shape before enabling by default.

- [ ] **Step 2: Run extension helper tests**

Run:

```bash
bun test starter-extensions/topology-context/index.test.ts
```

Expected: PASS.

---

### Task 5: Add deck-managed topology injection settings/state

**Files:**

- Modify: `apps/server/src/orientation-store.ts`
- Modify: `apps/server/src/routes-orientation.ts`
- Modify: `apps/server/src/env-schema.ts`
- Modify: `apps/server/src/orientation-store.test.ts`

- [ ] **Step 1: Write failing orientation-store tests**

Add tests beside `maintenance gate state` in `apps/server/src/orientation-store.test.ts`:

```ts
describe("topology context injection state", () => {
	test("defaults to disabled and inactive", () => {
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(false);
		expect(state.active).toBe(false);
		expect(state.inactiveReason).toBe("disabled");
		expect(state.apiBase.value).toBe("http://127.0.0.1:8787/api");
		expect(state.maxFocusChars.value).toBe(12_000);
		expect(state.timeoutMs.value).toBe(1500);
		expect(state.installedExtensionPath).toContain("topology-context");
	});

	test("enabled requires API base", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		delete process.env.OMP_DECK_API_BASE;
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(true);
		expect(state.active).toBe(false);
		expect(state.inactiveReason).toBe("missing_api_base");
	});

	test("enabled with loopback API base can become active when extension is installed", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_ENABLED = "1";
		process.env.OMP_DECK_API_BASE = "http://127.0.0.1:8787/api";
		const state = readTopologyContextInjectionState();
		expect(state.enabled).toBe(true);
		expect(state.apiBase.value).toBe("http://127.0.0.1:8787/api");
		if (state.installedExtensionPresent) {
			expect(state.active).toBe(true);
			expect(state.inactiveReason).toBeUndefined();
		} else {
			expect(state.active).toBe(false);
			expect(state.inactiveReason).toBe("extension_missing");
		}
	});

	test("knob overrides surface value/source/raw", () => {
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS = "9000";
		process.env.OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS = "2500";
		const state = readTopologyContextInjectionState();
		expect(state.maxFocusChars.value).toBe(9000);
		expect(state.maxFocusChars.rawValue).toBe("9000");
		expect(state.timeoutMs.value).toBe(2500);
	});
});
```

Add these env keys to the test cleanup list:

```ts
"OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
"OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
"OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
"OMP_DECK_API_BASE",
```

- [ ] **Step 2: Implement env keys and state reader**

In `apps/server/src/orientation-store.ts`, add:

```ts
export const TOPOLOGY_CONTEXT_DEFAULTS = {
	apiBase: "http://127.0.0.1:8787/api",
	maxFocusChars: 12_000,
	timeoutMs: 1500,
} as const;

export const TOPOLOGY_CONTEXT_ENV_KEYS = {
	enabled: "OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
	apiBase: "OMP_DECK_API_BASE",
	maxFocusChars: "OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
	timeoutMs: "OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
} as const;
```

Implement `readTopologyContextInjectionState()` using the same managed-env resolution pattern as `readMaintenanceGateState()`.

For install status:

- bundled path: repo `starter-extensions/topology-context/index.ts`.
- installed path: `~/.omp/agent/extensions/topology-context/index.ts`.
- if installed missing: `installStatus: "missing"`.
- if installed and bundled hashes match: `"current"`.
- if installed exists but hash differs: `"user-owned-or-outdated"`.

Do not auto-overwrite a user-owned installed copy.

- [ ] **Step 3: Add env schema entries**

In `apps/server/src/env-schema.ts`, add:

```ts
{
	key: "OMP_DECK_TOPOLOGY_CONTEXT_ENABLED",
	valueType: "boolean",
	sensitive: false,
	restartRequired: false,
	hotApply: true,
	description: "Enable the deck topology-context extension when truthy. Default off.",
},
{
	key: "OMP_DECK_TOPOLOGY_CONTEXT_MAX_FOCUS_CHARS",
	defaultValue: "12000",
	valueType: "int",
	sensitive: false,
	restartRequired: false,
	hotApply: true,
	description: "Maximum topology focus characters injected by the topology-context extension.",
},
{
	key: "OMP_DECK_TOPOLOGY_CONTEXT_TIMEOUT_MS",
	defaultValue: "1500",
	valueType: "int",
	sensitive: false,
	restartRequired: false,
	hotApply: true,
	description: "Loopback HTTP timeout for topology-context focus fetches.",
},
```

- [ ] **Step 4: Preserve shared API-base semantics**

Do not add a topology-specific API-base env var and do not imply the extension always sees `OMP_DECK_API_BASE` by default. `OMP_DECK_API_BASE` remains the shared deck API-base knob used by other deck integrations.

If `readTopologyContextInjectionState()` presents a default API base, it is a UI/default value only. Activation still requires an explicit effective `OMP_DECK_API_BASE` in process env or the managed env file. The `PUT /orientation/topology-context-injection` route may write `OMP_DECK_API_BASE` when the request includes `apiBase`, including when the UI submits its displayed default.

Do not set `OMP_DECK_TOPOLOGY_CONTEXT_ENABLED` in `apps/server/src/index.ts`. Default stays off.

- [ ] **Step 5: Add orientation routes**

In `apps/server/src/routes-orientation.ts`, add:

```ts
app.get("/orientation/topology-context-injection", (c) => {
	const body: TopologyContextInjectionState = readTopologyContextInjectionState();
	return c.json(body);
});

app.put("/orientation/topology-context-injection", async (c) => {
	let body: UpdateTopologyContextInjectionRequest;
	try {
		body = (await c.req.json()) as UpdateTopologyContextInjectionRequest;
	} catch {
		return c.json({ error: "invalid json body" }, 400);
	}
	const updates: Record<string, string | null> = {};
	if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
		updates[TOPOLOGY_CONTEXT_ENV_KEYS.enabled] = body.enabled ? "1" : null;
	}
	if (Object.prototype.hasOwnProperty.call(body, "apiBase")) {
		updates[TOPOLOGY_CONTEXT_ENV_KEYS.apiBase] = body.apiBase?.trim() || null;
	}
	for (const [field, key] of [["maxFocusChars", TOPOLOGY_CONTEXT_ENV_KEYS.maxFocusChars], ["timeoutMs", TOPOLOGY_CONTEXT_ENV_KEYS.timeoutMs]] as const) {
		if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
		const raw = body[field];
		updates[key] = raw === null || raw === undefined ? null : String(Math.floor(raw));
	}
	await writeManagedEnvUpdates(updates);
	applyManagedEnvUpdatesToProcess(updates);
	return c.json(readTopologyContextInjectionState());
});
```

Apply the same validation/audit style used by `/orientation/maintenance-gate`; do not accept non-positive numeric values.

- [ ] **Step 6: Run orientation tests and server typecheck**

Run:

```bash
bun test apps/server/src/orientation-store.test.ts
bun run --filter '@omp-deck/server' typecheck
```

Expected: PASS.

---

### Task 6: Add Settings UI controls

**Files:**

- Modify: `apps/web/src/lib/orientation-api.ts`
- Modify: `apps/web/src/views/SettingsView.tsx`

- [ ] **Step 1: Add API client methods**

In `apps/web/src/lib/orientation-api.ts`, add imports for the new protocol types and methods:

```ts
getTopologyContextInjection(): Promise<TopologyContextInjectionState> {
	return req<TopologyContextInjectionState>("/orientation/topology-context-injection");
},
putTopologyContextInjection(body: UpdateTopologyContextInjectionRequest): Promise<TopologyContextInjectionState> {
	return req<TopologyContextInjectionState>("/orientation/topology-context-injection", {
		method: "PUT",
		body: JSON.stringify(body),
	});
},
```

- [ ] **Step 2: Add Settings card**

In `apps/web/src/views/SettingsView.tsx`, add `TopologyContextInjectionCard` near `MaintenanceGateCard`.

The card must show:

- Enable checkbox, default off.
- API base input.
- max focus chars input.
- timeout ms input.
- installed extension path.
- install status: `missing`, `current`, or `user-owned-or-outdated`.
- active/inactive reason.
- warning text: installed extension copies are user-owned; deck does not overwrite modified installed copies. Delete `~/.omp/agent/extensions/topology-context/` and restart deck to reinstall the bundled starter.

- [ ] **Step 3: Run web typecheck**

Run:

```bash
bun run --filter '@omp-deck/web' typecheck
```

Expected: PASS.

---

### Task 7: Verify installer behavior

**Files:**

- Modify: existing starter-extension tests if present, or create `apps/server/src/starter-extensions.test.ts`.

- [ ] **Step 1: Add installer tests**

Test behavior:

1. When `starter-extensions/topology-context/index.ts` exists and target is missing, `installStarterExtensions()` copies it into `~/.omp/agent/extensions/topology-context/`.
2. When target already exists with different content, installer reports it as skipped and does not overwrite.

Use temp HOME/agent dirs if existing installer tests already do so. If not, add test seams only around source/target roots rather than mutating the real home directory.

- [ ] **Step 2: Run installer tests**

Run:

```bash
bun test apps/server/src/starter-extensions.test.ts
```

Expected: PASS.

If adding a clean test seam to `starter-extensions.ts` would make production more complex than the value of this test, skip the test and document the installer behavior through `readTopologyContextInjectionState()` install status tests instead.

---

### Task 8: Final verification

Run from repository root:

```bash
bun test apps/server/src/routes-session-context.test.ts
bun test starter-extensions/topology-context/index.test.ts
bun test apps/server/src/orientation-store.test.ts
bun run --filter '@omp-deck/server' test
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' typecheck
```

Expected:

- Route tests pass, including `/context-focus` active and persisted-session cases.
- Extension helper tests pass.
- Orientation-store tests pass with default-off activation behavior.
- Server package tests pass.
- Server typecheck passes.
- Web typecheck passes.

Manual smoke, only after automated checks pass:

1. Start deck dev server.
2. In Settings, enable Topology Context Injection and save.
3. Confirm state reports `enabled: true`; if installed extension is missing, restart deck so starter extension installer can copy it.
4. Build/rebuild topology for a session.
5. Send a normal user prompt below 15% context usage.
6. Confirm via OMP logs or a temporary extension debug flag that `/sessions/:id/context-focus` was fetched and the returned focus was added through the context hook's replacement array.
7. Confirm the chosen injected message shape reaches provider-bound context and does not break OMP message conversion.
8. Confirm no `deck-session-topology-context` entry is persisted into the session JSONL.

Do not use raw transcript grep alone as proof of clean model-facing focus. For focus content, parse the returned `/context-focus` JSON and verify the `<session_topology_subgraph>` payload lacks `importance`, `weight`, `confidence`, `relevance`, `score`, and `reasons` fields.

---

## Completion criteria

Plan B is complete when:

- The extension is shipped under `starter-extensions/topology-context/`.
- User-facing enablement defaults off.
- Activation requires truthy `OMP_DECK_TOPOLOGY_CONTEXT_ENABLED`, explicit valid loopback `OMP_DECK_API_BASE`, and non-empty `ctx.sessionManager.getSessionId()`.
- The extension fetches focus through deck HTTP and never reads deck SQLite directly.
- The extension returns replacement `messages` arrays and does not call `sendMessage(nextTurn)`.
- `/context-focus` reuses `getStoredQueryTopologyFocus()` so model-facing topology JSON stays clean.
- Settings exposes status/config and warns that installed extension copies are user-owned.
- Existing 15% compact-triggered replacement remains unchanged.
