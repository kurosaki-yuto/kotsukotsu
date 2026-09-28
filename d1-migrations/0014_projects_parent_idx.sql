-- projects had no index on parent_goal_id: every child-goal lookup (tree
-- rendering, list_subtasks, move_goal, the SUBTREE_CTE recursive join used
-- for scoped-member access checks) was a full table scan. Now ~450+ rows
-- and growing, so this was the main source of app + MCP slowness.
CREATE INDEX IF NOT EXISTS projects_parent_ws_order_idx ON projects(parent_goal_id, workspace_id, order_idx);
