-- 005-workspaces.sql
-- User-managed workspace registry. Rows here only affect deck's workspace list;
-- deleting a row never deletes files or OMP sessions.
CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    cwd         TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_updated ON workspaces(updated_at DESC);
