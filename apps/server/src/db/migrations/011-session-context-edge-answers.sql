-- 011-session-context-edge-answers.sql
-- Rebuild the checked edge table to add the structural answers relation.
-- The migration runner already wraps this file in one transaction.

CREATE TABLE session_context_edges_new (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    source_node_id      TEXT NOT NULL,
    target_node_id      TEXT NOT NULL,
    relation            TEXT NOT NULL CHECK (relation IN (
        'caused_by','fixed_by','verified_by','depends_on','supersedes',
        'references_file','continues','contradicts','blocks','summarizes','answers'
    )),
    weight              REAL NOT NULL DEFAULT 1.0,
    evidence_message_id TEXT,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(source_node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(target_node_id) REFERENCES session_context_nodes(id) ON DELETE CASCADE
);

INSERT INTO session_context_edges_new (
    id, session_id, source_node_id, target_node_id, relation,
    weight, evidence_message_id, metadata_json
)
SELECT
    id, session_id, source_node_id, target_node_id, relation,
    weight, evidence_message_id, metadata_json
FROM session_context_edges;

DROP TABLE session_context_edges;
ALTER TABLE session_context_edges_new RENAME TO session_context_edges;

CREATE INDEX idx_session_context_edges_session
    ON session_context_edges(session_id, relation);
CREATE INDEX idx_session_context_edges_source
    ON session_context_edges(source_node_id);
CREATE INDEX idx_session_context_edges_target
    ON session_context_edges(target_node_id);
