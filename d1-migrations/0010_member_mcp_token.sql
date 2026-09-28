-- Per-member MCP token: lets an assigned (possibly goal-scoped) member connect
-- their own AI. The MCP worker resolves this token to (workspace, user, scope)
-- and confines every tool to the member's scope_goal_id subtree.
ALTER TABLE workspace_members ADD COLUMN mcp_token TEXT;
