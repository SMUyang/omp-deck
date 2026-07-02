-- 005-session-context.sql
-- Deck-owned derived session context graph. This stores compressed, source-
-- referenced context for a session so future continuations can retrieve a
-- compact context pack instead of replaying raw transcript.

CREATE TABLE IF NOT EXISTS session_context_nodes (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN (
        'goal','user_intent','constraint','decision','action','artifact',
        'issue','resolution','evidence','todo_state','handoff_summary'
    )),
    title               TEXT NOT NULL,
    body                TEXT NOT NULL,
    compressed_body     TEXT NOT NULL,
    source_message_id   TEXT,
    source_turn_index   INTEGER,
    importance          REAL NOT NULL DEFAULT 0.5,
    created_at          TEXT NOT NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_context_nodes_session_kind
    ON session_context_nodes(session_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_source
    ON session_context_nodes(session_id, source_message_id);

CREATE TABLE IF NOT EXISTS session_context_edges (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    source_node_id      TEXT NOT NULL,
    target_node_id      TEXT NOT NULL,
    relation            TEXT NOT NULL CHECK (relation IN (
        'caused_by','fixed_by','verified_by','depends_on','supersedes',
        'references_file','continues','contradicts','blocks','summarizes'
    )),
    weight              REAL NOT NULL DEFAULT 1.0,
    evidence_message_id TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(source_node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(target_node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_context_edges_session
    ON session_context_edges(session_id, relation);
CREATE INDEX IF NOT EXISTS idx_session_context_edges_source
    ON session_context_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_session_context_edges_target
    ON session_context_edges(target_node_id);

CREATE TABLE IF NOT EXISTS session_context_artifacts (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    node_id         TEXT,
    kind            TEXT NOT NULL CHECK (kind IN ('file','commit','url','test','command','api','log','image','other')),
    ref             TEXT NOT NULL,
    label           TEXT NOT NULL,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(node_id) REFERENCES session_context_nodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_context_artifacts_session
    ON session_context_artifacts(session_id, kind);
CREATE INDEX IF NOT EXISTS idx_session_context_artifacts_node
    ON session_context_artifacts(node_id);

CREATE TABLE IF NOT EXISTS session_context_checkpoints (
    session_id          TEXT PRIMARY KEY,
    source_path         TEXT NOT NULL,
    source_mtime_ms     INTEGER NOT NULL,
    source_size_bytes   INTEGER NOT NULL,
    node_count          INTEGER NOT NULL,
    edge_count          INTEGER NOT NULL,
    rebuilt_at          TEXT NOT NULL
);
