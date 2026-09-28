-- 「現状」「完了の基準」が最後に書き換えられた日時。
-- タスクの動き (completed_at / created_at) と比べて、現状が古くなっていないかを
-- 画面と MCP の自動の進捗欄で示すために使う。既存の行は記録が無いので NULL のまま。
ALTER TABLE projects ADD COLUMN state_updated_at TEXT;
ALTER TABLE projects ADD COLUMN criteria_updated_at TEXT;
