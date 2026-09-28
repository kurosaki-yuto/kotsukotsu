-- Task-scoped invites. An invite may target a single goal; the accepted member
-- is restricted to that goal and everything below it (its subtree) — they can
-- neither see nor touch anything else in the workspace.

PRAGMA foreign_keys = ON;

-- NULL = full workspace access (normal member/admin). Non-NULL = the member is
-- confined to this goal's subtree.
ALTER TABLE workspace_members ADD COLUMN scope_goal_id TEXT;

-- The goal an invite grants access to. NULL = full workspace membership.
ALTER TABLE invites ADD COLUMN goal_id TEXT;
