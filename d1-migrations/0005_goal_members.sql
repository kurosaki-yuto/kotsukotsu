-- Per-goal member assignment + edit permission. Creator = admin of the goal.
ALTER TABLE projects ADD COLUMN created_by TEXT;

CREATE TABLE IF NOT EXISTS goal_members (
  goal_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  can_edit    INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (goal_id, member_id)
);
CREATE INDEX IF NOT EXISTS goal_members_goal_idx ON goal_members (goal_id);

-- Drop the seeded AI member (Addy) — no longer wanted.
DELETE FROM members WHERE is_ai = 1;
