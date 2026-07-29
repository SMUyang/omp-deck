-- 009-context-evidence-awaiting-usage.sql
-- Add 'awaiting_usage' as a valid status for context_replacement_events. The
-- bridge uses this when a focus replacement was confirmed (LLM received the
-- focus) but the post-replace context usage drop never surfaced within
-- RPC_USAGE_UPDATE_TIMEOUT_MS. A poll loop or manual refresh can still
-- complete the record via completePendingFromUsage.

-- SQLite stores the CHECK expression as text in sqlite_master; the standard
-- way to extend a CHECK constraint is to drop+recreate the table. We do not
-- actually want to drop data, so we instead rebuild the table with the new
-- constraint and copy rows over.


CREATE TABLE IF NOT EXISTS context_replacement_events_new (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (
        'constructed',
        'handler_returned',
        'compact_requested',
        'compact_completed',
        'usage_drop_observed',
        'provider_payload_observed',
        'awaiting_usage',
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
    focus_preview        TEXT NOT NULL,
    focus_estimated_tokens INTEGER NOT NULL DEFAULT 0,
    focus_estimate_method TEXT NOT NULL DEFAULT 'chars_div_4',
    provider_role        TEXT,
    error_message        TEXT,
    retry_count          INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

INSERT INTO context_replacement_events_new
SELECT * FROM context_replacement_events
WHERE status NOT IN ('awaiting_usage');

-- Rows that were already at 'failed' or 'timed_out' before this migration
-- stay at that status. Anything currently in flight (constructed / compact
-- requested / provider_payload_observed) is left in the new table.

DROP TABLE context_replacement_events;
ALTER TABLE context_replacement_events_new RENAME TO context_replacement_events;

CREATE INDEX IF NOT EXISTS idx_context_replacement_events_status
    ON context_replacement_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_replacement_events_session
    ON context_replacement_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_replacement_events_hash
    ON context_replacement_events(focus_hash);

