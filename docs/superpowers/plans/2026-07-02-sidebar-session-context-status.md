# Sidebar Session Context Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight topology-memory status chip to each left sidebar session row, with user-triggered rebuild and row-local status updates.

**Architecture:** Reuse the existing session context checkpoint as the cheap status source. Add a small protocol response type, a DB read helper, and a `GET /sessions/:id/context-status` route. The web sidebar renders a small extracted `SessionContextStatusChip` per row; full context details stay in the existing chat `ContextPackPanel`.

**Tech Stack:** TypeScript, Bun test, Hono routes, SQLite via existing DB helpers, React, i18next.

---

## File structure

- `packages/protocol/src/index.ts`
  - Add `SessionContextStatusResponse` next to existing session context response types.
- `apps/server/src/db/session-context.ts`
  - Add checkpoint row type and `getSessionContextStatus(sessionId)`.
- `apps/server/src/db/session-context.test.ts`
  - Test status helper before/after checkpoint upsert.
- `apps/server/src/routes-session-context.ts`
  - Add `GET /sessions/:id/context-status`.
- `apps/server/src/routes-session-context.test.ts`
  - Test 404, unbuilt status, rebuilt status, and no graph payload arrays.
- `apps/web/src/lib/api.ts`
  - Add `getSessionContextStatus(id)`.
- `apps/web/src/components/session/SessionContextStatusChip.tsx`
  - New row-level chip component; owns fetch/rebuild state for one session.
- `apps/web/src/components/Sidebar.tsx`
  - Pass `sessionId` into each row and render the chip under existing metadata.
- `apps/web/src/i18n/index.ts`
  - Add `sessionContext.sidebarStatus` labels in English and Chinese.

---

## Task 1: Protocol and DB status helper

**Files:**

- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/db/session-context.ts`
- Modify: `apps/server/src/db/session-context.test.ts`

- [ ] **Step 1: Add failing DB status tests**

Append these tests to `apps/server/src/db/session-context.test.ts` inside the existing `describe` block, or add a new `describe("session context status", ...)` in the same file using the existing temp DB helpers:

```ts
import type { SessionContextStatusResponse } from "@omp-deck/protocol";
import { getSessionContextStatus, upsertSessionContextCheckpoint } from "./session-context.ts";

test("returns unbuilt status when a session has no checkpoint", () => {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });

	const status = getSessionContextStatus("s-missing");

	expect(status).toEqual<SessionContextStatusResponse>({
		sessionId: "s-missing",
		built: false,
		nodeCount: 0,
		edgeCount: 0,
	});
});

test("returns checkpoint counts for built session context", () => {
	const dir = tempDir();
	openDb({ path: path.join(dir, "deck.db") });

	upsertSessionContextCheckpoint({
		sessionId: "s1",
		sourcePath: "/tmp/s1.jsonl",
		sourceMtimeMs: 1234,
		sourceSizeBytes: 5678,
		nodeCount: 12,
		edgeCount: 3,
		rebuiltAt: "2026-07-02T00:00:00.000Z",
	});

	expect(getSessionContextStatus("s1")).toEqual<SessionContextStatusResponse>({
		sessionId: "s1",
		built: true,
		nodeCount: 12,
		edgeCount: 3,
		rebuiltAt: "2026-07-02T00:00:00.000Z",
		sourceMtimeMs: 1234,
		sourceSizeBytes: 5678,
	});
});
```

If the file already imports `getSessionContextStatus` or `SessionContextStatusResponse`, merge imports instead of duplicating them.

- [ ] **Step 2: Run tests to verify RED**

Run:

```sh
bun test apps/server/src/db/session-context.test.ts
```

Expected: FAIL because `SessionContextStatusResponse` and `getSessionContextStatus` do not exist.

- [ ] **Step 3: Add protocol response type**

In `packages/protocol/src/index.ts`, place this after `SessionContextRebuildResponse` and before `SessionContextOmitted`:

```ts
export interface SessionContextStatusResponse {
	sessionId: string;
	built: boolean;
	nodeCount: number;
	edgeCount: number;
	rebuiltAt?: string;
	sourceMtimeMs?: number;
	sourceSizeBytes?: number;
}
```

- [ ] **Step 4: Implement DB status helper**

In `apps/server/src/db/session-context.ts`, extend the type import:

```ts
import type {
	SessionContextArtifact,
	SessionContextEdge,
	SessionContextGraphResponse,
	SessionContextNode,
	SessionContextStatusResponse,
} from "@omp-deck/protocol";
```

Add this row interface near the existing row interfaces:

```ts
interface CheckpointRow {
	session_id: string;
	source_path: string;
	source_mtime_ms: number;
	source_size_bytes: number;
	node_count: number;
	edge_count: number;
	rebuilt_at: string;
}
```

Append this helper after `upsertSessionContextCheckpoint`:

```ts
export function getSessionContextStatus(sessionId: string): SessionContextStatusResponse {
	const row = getDb()
		.prepare("SELECT session_id, source_path, source_mtime_ms, source_size_bytes, node_count, edge_count, rebuilt_at FROM session_context_checkpoints WHERE session_id = ?")
		.get(sessionId) as CheckpointRow | undefined;
	if (!row) {
		return {
			sessionId,
			built: false,
			nodeCount: 0,
			edgeCount: 0,
		};
	}
	return {
		sessionId: row.session_id,
		built: true,
		nodeCount: row.node_count,
		edgeCount: row.edge_count,
		rebuiltAt: row.rebuilt_at,
		sourceMtimeMs: row.source_mtime_ms,
		sourceSizeBytes: row.source_size_bytes,
	};
}
```

- [ ] **Step 5: Run DB tests and protocol typecheck**

Run:

```sh
bun test apps/server/src/db/session-context.test.ts
bun run --filter '@omp-deck/protocol' typecheck
bun run --filter '@omp-deck/server' typecheck
```

Expected: all exit 0.

- [ ] **Step 6: Commit Task 1**

```sh
git add packages/protocol/src/index.ts apps/server/src/db/session-context.ts apps/server/src/db/session-context.test.ts
git commit -m "Add session context status helper"
```

---

## Task 2: Context status route

**Files:**

- Modify: `apps/server/src/routes-session-context.ts`
- Modify: `apps/server/src/routes-session-context.test.ts`

- [ ] **Step 1: Add failing route tests**

Update `apps/server/src/routes-session-context.test.ts` type imports:

```ts
import type {
	SessionContextGraphResponse,
	SessionContextPackResponse,
	SessionContextRebuildResponse,
	SessionContextStatusResponse,
} from "@omp-deck/protocol";
```

First update the test stub so status can validate active and persisted sessions:

```ts
interface StubHandle {
	sessionId: string;
	sessionFile?: string;
}

function makeBridge(handle: StubHandle | undefined, persistedIds: string[] = []): AgentBridge {
	return {
		getSession: () => handle,
		listSessions: async () => persistedIds.map((id) => ({
			id,
			path: `/tmp/${id}.jsonl`,
			cwd: "/repo",
			title: id,
			createdAt: "2026-07-02T00:00:00.000Z",
			updatedAt: "2026-07-02T00:00:00.000Z",
			messageCount: 1,
		})),
	} as unknown as AgentBridge;
}
```

Then append this describe block after the existing rebuild tests and before context-pack tests:

```ts
describe("GET /sessions/:id/context-status", () => {
	test("returns 404 when session not found in active or persisted sessions", async () => {
		const app = buildSessionContextRouter(makeBridge(undefined, ["other"]));
		const res = await app.request("/sessions/missing/context-status");
		expect(res.status).toBe(404);
	});

	test("returns unbuilt status for an active session with no checkpoint", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const app = buildSessionContextRouter(makeBridge({ sessionId: "s1", sessionFile: path.join(dir, "s1.jsonl") }));

		const res = await app.request("/sessions/s1/context-status");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionContextStatusResponse;
		expect(body).toEqual({ sessionId: "s1", built: false, nodeCount: 0, edgeCount: 0 });
		expect("nodes" in body).toBe(false);
		expect("artifacts" in body).toBe(false);
	});

	test("returns unbuilt status for a persisted session row with no active handle", async () => {
		const dir = tempDir();
		openDb({ path: path.join(dir, "deck.db") });
		const app = buildSessionContextRouter(makeBridge(undefined, ["persisted-s1"]));

		const res = await app.request("/sessions/persisted-s1/context-status");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionContextStatusResponse;
		expect(body).toEqual({ sessionId: "persisted-s1", built: false, nodeCount: 0, edgeCount: 0 });
	});

	test("returns built status after rebuild", async () => {
		const { app } = setupSession();
		await app.request("/sessions/s1/context/rebuild", { method: "POST" });

		const res = await app.request("/sessions/s1/context-status");

		expect(res.status).toBe(200);
		const body = (await res.json()) as SessionContextStatusResponse;
		expect(body.sessionId).toBe("s1");
		expect(body.built).toBe(true);
		expect(body.nodeCount).toBeGreaterThan(0);
		expect(body.edgeCount).toBeGreaterThanOrEqual(0);
		expect(typeof body.rebuiltAt).toBe("string");
		expect(typeof body.sourceMtimeMs).toBe("number");
		expect(typeof body.sourceSizeBytes).toBe("number");
		expect("nodes" in body).toBe(false);
	});
});
```

- [ ] **Step 2: Run route tests to verify RED**

Run:

```sh
bun test apps/server/src/routes-session-context.test.ts
```

Expected: FAIL with 404 or missing route for `/context-status`.

- [ ] **Step 3: Implement status route**

In `apps/server/src/routes-session-context.ts`, change the DB import:

```ts
import { getSessionContextGraph, getSessionContextStatus } from "./db/session-context.ts";
```

Add this route after the rebuild route and before context-pack:

```ts
	app.get("/sessions/:id/context-status", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) {
			const sessions = await bridge.listSessions({});
			if (!sessions.some((session) => session.id === id)) return c.json({ error: "session not found" }, 404);
		}
		return c.json(getSessionContextStatus(id));
	});
```

- [ ] **Step 4: Run route tests and server typecheck**

Run:

```sh
bun test apps/server/src/routes-session-context.test.ts apps/server/src/db/session-context.test.ts
bun run --filter '@omp-deck/server' typecheck
```

Expected: all exit 0.

- [ ] **Step 5: Commit Task 2**

```sh
git add apps/server/src/routes-session-context.ts apps/server/src/routes-session-context.test.ts
git commit -m "Serve session context status"
```

---

## Task 3: Web API and i18n

**Files:**

- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/i18n/index.ts`

- [ ] **Step 1: Add protocol import and API method**

In `apps/web/src/lib/api.ts`, add `SessionContextStatusResponse` to the existing protocol import block:

```ts
	SessionContextStatusResponse,
```

Add this method after `rebuildSessionContext`:

```ts
	getSessionContextStatus(id: string): Promise<SessionContextStatusResponse> {
		return request<SessionContextStatusResponse>(`/sessions/${encodeURIComponent(id)}/context-status`);
	},
```

- [ ] **Step 2: Add sidebar i18n keys**

In `apps/web/src/i18n/index.ts`, extend the English `sessionContext` block with:

```ts
					sidebarStatus: {
						label: "Topology",
						notBuilt: "Not built",
						building: "Building…",
						failed: "Build failed",
						unavailable: "Unavailable",
						counts: "{{nodes}} nodes · {{edges}} edges",
					},
```

Extend the Chinese `sessionContext` block with:

```ts
					sidebarStatus: {
						label: "拓扑",
						notBuilt: "未构建",
						building: "构建中…",
						failed: "构建失败",
						unavailable: "不可用",
						counts: "{{nodes}} nodes · {{edges}} edges",
					},
```

Do not rename existing `sessionContext` keys.

- [ ] **Step 3: Run web typecheck**

Run:

```sh
bun run --filter '@omp-deck/web' typecheck
```

Expected: exit 0.

- [ ] **Step 4: Commit Task 3**

```sh
git add apps/web/src/lib/api.ts apps/web/src/i18n/index.ts
git commit -m "Add session context status client"
```

---

## Task 4: Sidebar status chip component

**Files:**

- Create: `apps/web/src/components/session/SessionContextStatusChip.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Add view-model tests before UI code**

Because the web test suite currently tests pure view-model helpers more than DOM rendering, first create a small pure helper in the new component file and test it. Create `apps/web/src/components/session/SessionContextStatusChip.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";

import { buildSessionContextStatusLabel } from "./SessionContextStatusChip";

describe("buildSessionContextStatusLabel", () => {
	test("renders not built status", () => {
		expect(buildSessionContextStatusLabel({
			status: { sessionId: "s1", built: false, nodeCount: 0, edgeCount: 0 },
			t: (key) => key,
		})).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.notBuilt");
	});

	test("renders built counts", () => {
		expect(buildSessionContextStatusLabel({
			status: { sessionId: "s1", built: true, nodeCount: 12, edgeCount: 3 },
			t: (key, values) => `${key}:${values?.nodes}/${values?.edges}`,
		})).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.counts:12/3");
	});

	test("renders transient states", () => {
		expect(buildSessionContextStatusLabel({ state: "building", t: (key) => key })).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.building");
		expect(buildSessionContextStatusLabel({ state: "failed", t: (key) => key })).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.failed");
		expect(buildSessionContextStatusLabel({ state: "unavailable", t: (key) => key })).toBe("sessionContext.sidebarStatus.label · sessionContext.sidebarStatus.unavailable");
	});
});
```

- [ ] **Step 2: Run chip test to verify RED**

Run:

```sh
bun test apps/web/src/components/session/SessionContextStatusChip.test.ts
```

Expected: FAIL because `SessionContextStatusChip` does not exist.

- [ ] **Step 3: Create status chip component**

Create `apps/web/src/components/session/SessionContextStatusChip.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionContextStatusResponse } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ChipState = "idle" | "building" | "failed" | "unavailable";

type TFunction = (key: string, values?: Record<string, number>) => string;

export function buildSessionContextStatusLabel(input: {
	status?: SessionContextStatusResponse;
	state?: ChipState;
	t: TFunction;
}): string {
	const label = input.t("sessionContext.sidebarStatus.label");
	if (input.state === "building") return `${label} · ${input.t("sessionContext.sidebarStatus.building")}`;
	if (input.state === "failed") return `${label} · ${input.t("sessionContext.sidebarStatus.failed")}`;
	if (input.state === "unavailable") return `${label} · ${input.t("sessionContext.sidebarStatus.unavailable")}`;
	if (!input.status || !input.status.built) return `${label} · ${input.t("sessionContext.sidebarStatus.notBuilt")}`;
	return `${label} · ${input.t("sessionContext.sidebarStatus.counts", { nodes: input.status.nodeCount, edges: input.status.edgeCount })}`;
}

interface SessionContextStatusChipProps {
	sessionId: string;
	active?: boolean;
	className?: string;
}

export function SessionContextStatusChip({ sessionId, active = false, className }: SessionContextStatusChipProps) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<SessionContextStatusResponse | undefined>();
	const [state, setState] = useState<ChipState>("idle");
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		setError(undefined);
		void api.getSessionContextStatus(sessionId)
			.then((next) => {
				if (cancelled) return;
				setStatus(next);
				setState("idle");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setState("unavailable");
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const rebuild = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		setState("building");
		setError(undefined);
		try {
			await api.rebuildSessionContext(sessionId);
			setStatus(await api.getSessionContextStatus(sessionId));
			setState("idle");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setState("failed");
		}
	}, [sessionId]);

	const label = buildSessionContextStatusLabel({ status, state, t });
	return (
		<button
			type="button"
			className={cn(
				"mt-1 inline-flex max-w-full items-center rounded border border-line/70 px-1.5 py-0.5 font-mono text-[10px] text-ink-4 hover:border-line-strong hover:text-ink-2",
				active ? "bg-paper-2" : "bg-paper/40",
				className,
			)}
			onClick={rebuild}
			title={error ?? label}
		>
			<span className="truncate">{label}</span>
		</button>
	);
}
```


- [ ] **Step 4: Run chip test to verify GREEN**

Run:

```sh
bun test apps/web/src/components/session/SessionContextStatusChip.test.ts
```

Expected: PASS.

- [ ] **Step 5: Mount chip in Sidebar rows**

Modify `apps/web/src/components/Sidebar.tsx` imports:

```ts
import { SessionContextStatusChip } from "./session/SessionContextStatusChip";
```

Pass `sessionId` into both live and persisted rows:

```tsx
<SessionRow
	key={s.sessionId}
	sessionId={s.sessionId}
	...
/>
```

```tsx
<SessionRow
	key={s.id}
	sessionId={s.id}
	...
/>
```

Update `SessionRow` signature:

```tsx
function SessionRow({
	sessionId,
	title,
	subtitle,
	meta,
	active,
	live,
	planMode,
	onClick,
}: {
	sessionId: string;
	title: string;
	subtitle?: string;
	meta?: string;
	active?: boolean;
	live?: boolean;
	planMode?: boolean;
	onClick: () => void;
}) {
```

Render the chip after `meta`:

```tsx
			<div className="pl-3">
				<SessionContextStatusChip sessionId={sessionId} active={active} />
			</div>
```

The chip is a nested button inside the row button. If React or browser behavior warns about nested interactive elements, refactor `SessionRow` root to a `div` and keep a child button for session selection plus the chip button as a sibling. The preferred safe structure is:

```tsx
return (
	<div className={cn("group rounded-md px-2 py-1.5 text-[13px] transition-colors", active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60")}>
		<button type="button" onClick={onClick} className="block w-full text-left">
			{/* existing title/subtitle/meta content */}
		</button>
		<div className="pl-3">
			<SessionContextStatusChip sessionId={sessionId} active={active} />
		</div>
	</div>
);
```

Use this safe structure if adding the chip directly would nest buttons.

- [ ] **Step 6: Run sidebar-related checks**

Run:

```sh
bun test apps/web/src/components/session/SessionContextStatusChip.test.ts
bun run --filter '@omp-deck/web' typecheck
```

Expected: both exit 0.

- [ ] **Step 7: Commit Task 4**

```sh
git add apps/web/src/components/session/SessionContextStatusChip.tsx apps/web/src/components/session/SessionContextStatusChip.test.ts apps/web/src/components/Sidebar.tsx
git commit -m "Show session context status in sidebar"
```

---

## Task 5: End-to-end verification and polish

**Files:**

- Modify only files touched by failed checks.

- [ ] **Step 1: Run all targeted tests**

Run:

```sh
bun test apps/server/src/db/session-context.test.ts apps/server/src/session-context.test.ts apps/server/src/routes-session-context.test.ts apps/web/src/components/session/SessionContextStatusChip.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run typechecks and web build**

Run:

```sh
bun run --filter '@omp-deck/protocol' typecheck
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/web' build
```

Expected: all exit 0.

- [ ] **Step 3: Live API smoke**

Start the server on isolated ports/data path:

```sh
OMP_DECK_PORT=8891 OMP_DECK_WEB_PORT=5177 OMP_DECK_DB_PATH=/tmp/sct-sidebar-smoke.db bun apps/server/src/index.ts
```

Resume or create a session through the API, then run:

```sh
curl -s http://127.0.0.1:8891/api/sessions/<id>/context-status
curl -s -X POST http://127.0.0.1:8891/api/sessions/<id>/context/rebuild
curl -s http://127.0.0.1:8891/api/sessions/<id>/context-status
```

Expected:

- Before rebuild, status may be `built: false` if no checkpoint exists.
- Rebuild returns `nodeCount` and `edgeCount`.
- After rebuild, status returns `built: true` with matching counts.
- Response contains no `nodes`, `edges`, or `artifacts` arrays.

- [ ] **Step 4: Browser smoke**

Start web dev server if needed:

```sh
OMP_DECK_PORT=8891 bun run --filter '@omp-deck/web' dev -- --port 5177 --strictPort
```

Open `http://127.0.0.1:5177/`:

1. Confirm left sidebar session rows show topology status chips.
2. Confirm existing session title/cwd/time layout remains readable.
3. Click one chip and confirm it switches to building then node/edge counts.
4. Confirm selecting a session row still works.
5. Confirm the full chat `ContextPackPanel` still renders.

- [ ] **Step 5: Final review**

Dispatch reviewer with these focus areas:

- Status endpoint reads checkpoints only and returns bounded payload.
- No automatic rebuild of all sessions.
- Chip does not create invalid nested interactive markup.
- Rebuild click does not trigger row selection.
- Existing context pack panel remains mounted.
- No `any` in production code.

- [ ] **Step 6: Commit polish fixes if needed**

If smoke or review finds fixes:

```sh
git add packages/protocol/src/index.ts apps/server/src/db/session-context.ts apps/server/src/db/session-context.test.ts apps/server/src/routes-session-context.ts apps/server/src/routes-session-context.test.ts apps/web/src/lib/api.ts apps/web/src/i18n/index.ts apps/web/src/components/session/SessionContextStatusChip.tsx apps/web/src/components/session/SessionContextStatusChip.test.ts apps/web/src/components/Sidebar.tsx
git commit -m "Polish sidebar session context status"
```
