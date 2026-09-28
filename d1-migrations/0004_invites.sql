-- Workspace invites: admin generates a token/link; invitee registers with it and
-- joins with the invite's role. Open self-registration still allowed.
CREATE TABLE IF NOT EXISTS invites (
  token            TEXT PRIMARY KEY,
  email            TEXT,
  role             TEXT NOT NULL DEFAULT 'member',
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at       TEXT,
  accepted_at      TEXT,
  accepted_user_id TEXT
);
CREATE INDEX IF NOT EXISTS invites_created_idx ON invites (created_at DESC);
