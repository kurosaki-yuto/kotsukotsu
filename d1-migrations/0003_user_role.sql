-- Auth roles: admin / member. First registered user becomes admin (handled in code).
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
