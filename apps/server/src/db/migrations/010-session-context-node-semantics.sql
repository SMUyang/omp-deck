-- 010-session-context-node-semantics.sql
-- Backward-compatible conversational semantics for session context nodes.

ALTER TABLE session_context_nodes ADD COLUMN population TEXT;
ALTER TABLE session_context_nodes ADD COLUMN node_role TEXT;
ALTER TABLE session_context_nodes ADD COLUMN origin TEXT;
ALTER TABLE session_context_nodes ADD COLUMN child_type TEXT;
ALTER TABLE session_context_nodes ADD COLUMN pair_id TEXT;
ALTER TABLE session_context_nodes ADD COLUMN parent_node_id TEXT;
ALTER TABLE session_context_nodes ADD COLUMN operation TEXT;
ALTER TABLE session_context_nodes ADD COLUMN operation_detail TEXT;
ALTER TABLE session_context_nodes ADD COLUMN purpose TEXT;
ALTER TABLE session_context_nodes ADD COLUMN purpose_source TEXT;
ALTER TABLE session_context_nodes ADD COLUMN refined_purpose TEXT;
ALTER TABLE session_context_nodes ADD COLUMN refinement_json TEXT;
ALTER TABLE session_context_nodes ADD COLUMN status TEXT;

ALTER TABLE session_context_checkpoints
    ADD COLUMN extraction_schema_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_session_context_nodes_population_role
    ON session_context_nodes(session_id, population, node_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_pair
    ON session_context_nodes(session_id, pair_id);
CREATE INDEX IF NOT EXISTS idx_session_context_nodes_parent
    ON session_context_nodes(parent_node_id);
