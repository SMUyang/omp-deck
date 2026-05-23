-- 004-state-entered-at.sql
--
-- T-79: kanban columns now auto-sort by "when this card last entered this
-- column" rather than by curated within-column drag order. This requires a
-- per-row timestamp that bumps only on cross-column moves — body edits and
-- within-column drags must NOT bump it.
--
-- Backfill: existing rows are seeded with `updated_at`. That is monotonic but
-- coarse — cards edited (body changes) more recently than they were moved will
-- sort higher than cards actually moved later. Self-corrects after the first
-- post-deploy cross-column move on each row.
--
-- The companion index supports the new ORDER BY in listTasks.

ALTER TABLE tasks ADD COLUMN state_entered_at TEXT;

UPDATE tasks SET state_entered_at = updated_at WHERE state_entered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_state_entered
    ON tasks(state_id, state_entered_at DESC);
