-- Multi-workspace (multi-tenant). Turns the single hardcoded org into real,
-- switchable workspaces. A user can belong to many workspaces with a per-
-- workspace role. All existing data is migrated into the 'default' workspace so
-- nothing breaks; new tenant rows carry workspace_id from the active session.

PRAGMA foreign_keys = ON;

-- ---- workspaces (replaces the org_settings singleton) ----
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name       TEXT NOT NULL,
  timezone   TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  logo_url   TEXT,
  mcp_token  TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- workspace membership (user <-> workspace, role per workspace) ----
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',   -- admin / member
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);

-- seed the 'default' workspace from the existing org_settings singleton
INSERT INTO workspaces (id, name, timezone, logo_url, mcp_token)
  SELECT 'default', name, timezone, logo_url, mcp_token FROM org_settings WHERE id = 1;
-- guarantee a default workspace exists even if org_settings was empty
INSERT INTO workspaces (id, name)
  SELECT 'default', 'マイワークスペース'
  WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE id = 'default');

-- enroll every existing user into the default workspace (admins keep admin)
INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
  SELECT 'default', id, COALESCE(role, 'member') FROM users;

-- ---- add workspace_id to all tenant tables, backfilling 'default' ----
ALTER TABLE projects      ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE nodes         ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE members       ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE invites       ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notifications ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE chat_messages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE resources     ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE done_log      ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS projects_ws_idx      ON projects(workspace_id, order_idx);
CREATE INDEX IF NOT EXISTS nodes_ws_idx         ON nodes(workspace_id);
CREATE INDEX IF NOT EXISTS members_ws_idx       ON members(workspace_id);
CREATE INDEX IF NOT EXISTS notifications_ws_idx ON notifications(workspace_id, created_at DESC);

-- each session remembers which workspace it is currently viewing
ALTER TABLE sessions ADD COLUMN active_workspace_id TEXT NOT NULL DEFAULT 'default';
