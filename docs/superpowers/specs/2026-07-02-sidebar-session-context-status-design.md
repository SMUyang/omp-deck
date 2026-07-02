# Sidebar Session Context Status Design

## Goal

Show session context topology memory status inside each left sidebar session row,
without turning the sidebar into a full context-pack viewer.

The sidebar answers: "does this session have topology memory, how large is it,
and can I rebuild it quickly?" The existing chat `ContextPackPanel` remains the
place for full Summary, Goals, Decisions, Issues, Evidence, and Raw refs.

## Scope

In scope:

- Add a lightweight backend status endpoint for one session.
- Add a web API client method for that endpoint.
- Render a compact topology status chip in left sidebar session rows.
- Allow rebuilding context for the active/visible session from the row chip or
  adjacent action.
- Keep the existing chat context pack panel.

Out of scope:

- Moving the full Context Pack detail view into the sidebar.
- Automatically rebuilding all historical sessions.
- Writing to Mnemopi or any external memory store.
- Adding graph visualization.
- Solving remote Git divergence or reapplying the pre-merge stash.

## UX

Each session row will show one compact status line/chip:

- `拓扑 · 未构建` / `Topology · Not built`
- `拓扑 · 407 nodes · 11 edges`
- `拓扑 · 构建中…` / `Topology · Building…`
- `拓扑 · 构建失败` / `Topology · Build failed`

The chip is intentionally small. It must not push the session title off-screen or
replace existing title/cwd/time metadata.

Recommended behavior:

- On sidebar render, fetch status only for displayed rows, not all historical
  sessions globally.
- For sessions without a checkpoint, show `Not built`.
- Clicking the chip/action for a session triggers rebuild for that session.
- Rebuild success updates that row's status counts and timestamp in-place.
- Rebuild failure shows `Build failed` in the row and does not clear the last
  successful counts if they exist.

## Backend API

Add a route:

```http
GET /api/sessions/:id/context-status
```

Response:

```ts
interface SessionContextStatusResponse {
  sessionId: string;
  built: boolean;
  nodeCount: number;
  edgeCount: number;
  rebuiltAt?: string;
  sourceMtimeMs?: number;
  sourceSizeBytes?: number;
}
```

Semantics:

- `404` when the session is unknown to the bridge.
- `built: false`, `nodeCount: 0`, `edgeCount: 0` when no checkpoint exists.
- Counts come from `session_context_checkpoints`, not a graph query.
- The endpoint is read-only.

This keeps row status cheap and separate from `context-graph`, whose purpose is
to return graph content.

## Backend storage helper

Add a DB helper such as:

```ts
getSessionContextStatus(sessionId: string): SessionContextStatusResponse
```

It reads only `session_context_checkpoints`. It must not query nodes, edges, or
artifacts for the common sidebar path.

Writes remain limited to existing rebuild flow:

- `session_context_nodes`
- `session_context_edges`
- `session_context_artifacts`
- `session_context_checkpoints`

## Frontend API

Add:

```ts
getSessionContextStatus(id: string): Promise<SessionContextStatusResponse>
```

Existing methods stay unchanged:

- `rebuildSessionContext`
- `getSessionContextPack`
- `getSessionContextGraph`

## Frontend state and rendering

`Sidebar.tsx` should own the row-level UI. It can either:

1. keep a local `Record<string, RowStatus>` cache keyed by session id, or
2. use a small extracted component `SessionContextStatusChip` per row.

Recommendation: extract `SessionContextStatusChip` if the logic exceeds simple
rendering. The chip depends only on `sessionId`, active state if needed, and API
methods.

The component must avoid bulk rebuilds. It may fetch statuses for visible rows on
mount/effect, but rebuild is user-triggered.

## Error handling

- Status fetch failure: show a muted `Topology · unavailable`; do not break the
  sidebar or block normal session selection.
- Rebuild 404: show `Build failed` with the API error in a `title` attribute
  when available.
- Rebuild success with zero nodes: show `Topology · 0 nodes · 0 edges`, because
  that is a valid built state for empty sessions.

## i18n

Add keys under the existing `sessionContext` block:

```ts
sidebarStatus: {
  label: "Topology",
  notBuilt: "Not built",
  building: "Building…",
  failed: "Build failed",
  unavailable: "Unavailable",
  counts: "{{nodes}} nodes · {{edges}} edges",
}
```

Chinese:

```ts
sidebarStatus: {
  label: "拓扑",
  notBuilt: "未构建",
  building: "构建中…",
  failed: "构建失败",
  unavailable: "不可用",
  counts: "{{nodes}} nodes · {{edges}} edges",
}
```

Keep numeric words as `nodes`/`edges` unless the product already has localized
terms for graph counts.

## Tests

Follow TDD.

Backend tests:

1. `GET /sessions/:id/context-status` returns `404` for missing session.
2. Existing session without checkpoint returns `built: false` and zero counts.
3. After rebuild, status returns `built: true`, node/edge counts, and checkpoint
   metadata.
4. Status endpoint does not return graph node/artifact arrays.

Frontend tests if the project has a suitable component test harness:

1. Status chip renders `Not built` for unbuilt response.
2. Status chip renders counts for built response.
3. Clicking rebuild shows building state then updated counts.
4. Failed rebuild shows failure state.

If no component harness is practical, rely on TypeScript checks plus browser
smoke after implementation.

Required verification:

```sh
bun test apps/server/src/db/session-context.test.ts apps/server/src/session-context.test.ts apps/server/src/routes-session-context.test.ts
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/web' build
```

Browser smoke:

1. Open a session list with existing sessions.
2. Confirm row chips render without layout breakage.
3. Rebuild one session from the row chip/action.
4. Confirm the row updates to node/edge counts.
5. Confirm the full chat `ContextPackPanel` remains available.

## Risks

- Fetching status for too many rows could create sidebar API noise. Limit to
  displayed rows and avoid automatic rebuilds.
- Sidebar can become cramped. Keep content to one compact chip line.
- Session rows include both live and persisted sessions. The backend route uses
  bridge session visibility; if persisted-only rows need status later, add a
  disk-backed lookup separately rather than overloading this change.

## Acceptance criteria

- Sidebar session rows show topology status without replacing existing metadata.
- Rebuild from a row updates that row's status.
- Full context details remain in the chat panel.
- No Mnemopi writes.
- Status path is bounded and does not return graph payloads.
- Tests and typechecks pass.
