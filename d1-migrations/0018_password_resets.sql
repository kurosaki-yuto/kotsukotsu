-- Self-serve password reset. The account holder asks for a link from the login
-- screen, gets a one-shot token by email, and sets a new password themselves —
-- no admin in the loop, so a forgotten password never blocks on someone else
-- being awake.
--
-- The token is the only proof of identity in that flow, so it is deliberately
-- short-lived (1 hour), single-use (used_at), and revocable (older rows for the
-- same user are consumed when a new one is issued).
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  -- IP/UA of the requester, kept so an abusive burst can be traced after the fact
  requested_by TEXT
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);
