-- 008-context-evidence.sql
-- Append-only context replacement lifecycle evidence. One row per replacement
-- event; statuses track the full lifecycle from construction through provider
-- payload observation. Focus text is hashed, never stored in full. Focus token
-- estimate method is recorded explicitly (always "chars_div_4" at this revision)
-- to avoid ambiguity in downstream consumers.

CREATE TABLE IF NOT EXISTS context_replacement_events (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (
        'constructed',
        'handler_returned',
        'compact_requested',
        'compact_completed',
        'usage_drop_observed',
        'provider_payload_observed',
        'failed',
        'timed_out'
    )),
    mechanism            TEXT NOT NULL CHECK (mechanism IN (
        'context_hook',
        'auto_compact'
    )),
    before_tokens        INTEGER,
    before_percent       REAL,
    after_tokens         INTEGER,
    after_percent        REAL,
    saved_tokens         INTEGER,
    saved_percent        REAL,
    focus_hash           TEXT NOT NULL,
    focus_preview        TEXT NOT NULL,   -- first 240 chars of focus text, redacted
    focus_estimated_tokens INTEGER NOT NULL,
    focus_estimate_method TEXT NOT NULL DEFAULT 'chars_div_4',
    provider_role        TEXT,             -- null until provider_payload_observed
    error_message        TEXT,
    retry_count          INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_replacement_events_session
    ON context_replacement_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_replacement_events_status
    ON context_replacement_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_replacement_events_hash
    ON context_replacement_events(session_id, focus_hash);
