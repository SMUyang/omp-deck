# Workspace Management Design

## Goal

Add user-managed workspaces to omp-deck so a user can register a directory, optionally create it, select it for sessions, and later remove it from the deck workspace list without deleting files or sessions.

## Decisions

- Deletion is list-only. It removes a deck-owned workspace row; it never deletes the filesystem directory and never deletes OMP session files.
- Existing behavior stays intact: `OMP_DECK_DEFAULT_CWD`, `OMP_DECK_WORKSPACES`, and session-derived directories still appear in `GET /workspaces`.
- User-managed workspaces are persisted in the deck SQLite database, not in `OMP_DECK_WORKSPACES`.
- Only DB-backed workspaces are deletable. Default/env/session-derived entries are read-only.
- `POST /workspaces` accepts an absolute path. If `createDirectory` is true, the server creates the directory. If false, the path must already exist and be a directory.
- `label` is optional. Empty labels derive from the basename, matching existing workspace labels.

## Server Architecture

Add a focused workspace persistence module backed by a new SQLite `workspaces` table:

- `id TEXT PRIMARY KEY`
- `cwd TEXT NOT NULL UNIQUE`
- `label TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

A new `routes-workspaces.ts` owns `GET /workspaces`, `POST /workspaces`, and `DELETE /workspaces/:id`. `routes.ts` mounts that router and stops carrying inline workspace route logic.

`GET /workspaces` builds the same union as today, but with source metadata:

1. default cwd: `source: "default"`
2. env extra workspaces: `source: "env"`
3. DB rows: `source: "user"`, `id` included
4. session-derived cwds: `source: "session"`

If one cwd appears in multiple sources, the highest-priority source wins in that order: default, env, user, session. Session counts are always merged from `bridge.listSessions({})`.

## API Contract

Protocol additions:

```ts
export type WorkspaceSource = "default" | "env" | "user" | "session";

export interface WorkspaceEntry {
  cwd: string;
  label: string;
  sessionCount: number;
  source: WorkspaceSource;
  id?: string;
}

export interface CreateWorkspaceRequest {
  cwd: string;
  label?: string;
  createDirectory?: boolean;
}

export interface DeleteWorkspaceResponse extends ListWorkspacesResponse {
  ok: true;
}
```

`POST /workspaces` returns `ListWorkspacesResponse`. `DELETE /workspaces/:id` returns `DeleteWorkspaceResponse`. Validation errors return HTTP 400; missing DB workspace ids return 404.

## Web Architecture

Add API methods and store actions:

- `api.createWorkspace(body)`
- `api.deleteWorkspace(id)`
- `useStore().createWorkspace(body)`
- `useStore().deleteWorkspace(id)`

Both store actions update `workspaces` and `defaultCwd` from the server response. `deleteWorkspace` also clears a selected user workspace in UI state when the selected cwd is removed.

## UI

Sidebar:

- Keep the existing workspace selector.
- Add a small “Add” button near Refresh. It prompts for a directory path and an optional label. It calls `createWorkspace({ cwd, label, createDirectory: true })`.
- Add a small Remove button when the selected workspace has `source === "user"` and `id`. The confirmation text states that files and sessions are not deleted.

SessionPicker:

- Add the same “Add workspace” affordance next to its selector.
- Do not show deletion on the landing screen.

## Error Handling

- Relative paths are rejected.
- File paths are rejected; only directories are valid.
- Missing paths are rejected unless `createDirectory: true`.
- Duplicate cwd create is idempotent: update label if provided and return refreshed workspaces.
- Attempting to delete non-user workspaces is impossible by API because only DB rows have ids.

## Verification

- Server tests for create existing dir, create missing dir, reject relative path, reject file path, duplicate update, delete user workspace, missing delete 404, and merged list source/session counts.
- Web API/store tests for create/delete updating workspace state.
- UI smoke via browser: add a temp workspace, see it in the selector, select it, remove it, verify it disappears and the managed server remains healthy.
