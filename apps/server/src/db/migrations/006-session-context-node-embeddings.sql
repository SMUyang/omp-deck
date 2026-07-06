-- 007-session-context-node-embeddings.sql
-- Stores precomputed or lazy-fetched node embeddings for semantic retrieval.
-- Separate table to avoid ALTERing session_context_nodes and to allow
-- multiple embedding models per session if needed later.

CREATE TABLE IF NOT EXISTS session_context_node_embeddings (
    session_id      TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    embedding       BLOB NOT NULL,
    model           TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (session_id, node_id),
    FOREIGN KEY(node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_context_node_embeddings_session
    ON session_context_node_embeddings(session_id);
