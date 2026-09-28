-- Per-task due date/time + reminder. due_at is a full ISO 8601 UTC timestamp
-- (matches nowIso()/created_at's format so lexicographic comparison works).
-- reminded_at marks a due_at that has already fired its reminder notification
-- so the cron sweep never double-sends.
ALTER TABLE nodes ADD COLUMN due_at TEXT;
ALTER TABLE nodes ADD COLUMN reminded_at TEXT;
CREATE INDEX IF NOT EXISTS nodes_due_idx ON nodes(due_at) WHERE due_at IS NOT NULL;
