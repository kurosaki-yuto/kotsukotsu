-- @mention support for comments: a notification can now be targeted at one
-- specific member (by email) instead of broadcasting to everyone with access
-- to the goal. NULL keeps the existing broadcast behavior (completion/streak/
-- assignment notifications).
ALTER TABLE notifications ADD COLUMN target_email TEXT;
