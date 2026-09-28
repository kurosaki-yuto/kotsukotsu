-- Per-task (node) assignment: who "holds" each task in the hierarchy.
CREATE TABLE IF NOT EXISTS node_members (
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (node_id, member_id)
);
CREATE INDEX IF NOT EXISTS node_members_node_idx ON node_members (node_id);
