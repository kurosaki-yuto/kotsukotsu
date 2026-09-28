-- Addness todo D1 (SQLite) schema. Port of Supabase schema + auth.
-- ids = uuid (app-supplied) else random hex. timestamps = ISO8601 text.

PRAGMA foreign_keys = ON;

-- ---- auth ----
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- ---- goals (projects) ----
CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name                TEXT NOT NULL,
  order_idx           INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  emoji               TEXT,
  deadline            TEXT,
  current_state       TEXT,
  completion_criteria TEXT,
  owner               TEXT DEFAULT '管理者',
  status              TEXT NOT NULL DEFAULT 'active',
  archived_at         TEXT,
  parent_goal_id      TEXT REFERENCES projects(id) ON DELETE CASCADE
);

-- ---- subtasks (nodes) ----
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  text         TEXT NOT NULL DEFAULT '',
  order_idx    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  today_date   TEXT,
  estimate_min INTEGER
);
CREATE INDEX IF NOT EXISTS nodes_project_parent_order_idx ON nodes(project_id, parent_id, order_idx);
CREATE INDEX IF NOT EXISTS nodes_today_idx ON nodes(today_date);

-- ---- done log ----
CREATE TABLE IF NOT EXISTS done_log (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id   TEXT,
  project_name TEXT,
  text         TEXT NOT NULL,
  sub_md       TEXT,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS done_log_completed_at_idx ON done_log(completed_at DESC);

-- ---- org settings (singleton) ----
CREATE TABLE IF NOT EXISTS org_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL DEFAULT 'マイワークスペース',
  timezone   TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  logo_url   TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO org_settings (id) VALUES (1);

-- ---- members ----
CREATE TABLE IF NOT EXISTS members (
  id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'Admin',
  is_ai     INTEGER NOT NULL DEFAULT 0,
  is_you    INTEGER NOT NULL DEFAULT 0,
  email     TEXT,
  avatar    TEXT,
  points    INTEGER NOT NULL DEFAULT 0,
  streak    INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO members (name, role, is_you)
  SELECT '管理者', 'Admin', 1 WHERE NOT EXISTS (SELECT 1 FROM members WHERE is_you = 1);
INSERT INTO members (name, role, is_ai)
  SELECT 'Addy', 'None', 1 WHERE NOT EXISTS (SELECT 1 FROM members WHERE is_ai = 1);

-- ---- notifications ----
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT,
  goal_id    TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at DESC);

-- ---- chat messages ----
CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  goal_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL DEFAULT 'goal',
  role       TEXT NOT NULL DEFAULT 'user',
  author     TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS chat_messages_goal_idx ON chat_messages(goal_id, created_at);

-- ---- resources ----
CREATE TABLE IF NOT EXISTS resources (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  goal_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  url        TEXT,
  content    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS resources_goal_idx ON resources(goal_id, updated_at DESC);
