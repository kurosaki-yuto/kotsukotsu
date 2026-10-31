-- タスクが「ズレたまま・終わらないまま・途中で止まったまま」残るのを減らすための3つ (2026-11-01)。
--
-- 1. 作業の手順 (task_steps)
--    AI が作業を始めるときに切る手順 (「資料を読む」「下書きを作る」…) を、子タスクではなくタスクの中のチェックリストとして持つ。
--    子タスクにすると人が頼んだタスクと同じ盤に並び、残っているタスクの87%がこの手順になっていた。
--    手順はタスクを閉じれば一緒に用済みになる (盤には出ない)。
CREATE TABLE IF NOT EXISTS task_steps (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  text         TEXT NOT NULL,
  order_idx    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  done_at      TEXT,
  created_by   TEXT          -- 作った人の表示名 (AI ならトークンの持ち主)
);
CREATE INDEX IF NOT EXISTS task_steps_task_idx ON task_steps(task_id, order_idx);

-- 2. 止まった印
--    進行中 (started_at) のまま24時間なにも動かなかったタスクは、進行中を外して「止まっている」にする。
--    stalled_note に誰がいつ始めて止まったかを残す。動かす (開始・完了・現状の更新・手順の操作) か「確認した」で消える。
ALTER TABLE projects ADD COLUMN stalled_at TEXT;
ALTER TABLE projects ADD COLUMN stalled_note TEXT;

-- 3. 「閉じていい？」で「まだ」を押した時刻
--    この後に現状が書き換わるまで、候補に出さない。
ALTER TABLE projects ADD COLUMN close_dismissed_at TEXT;

CREATE INDEX IF NOT EXISTS projects_started_idx ON projects(workspace_id, started_at) WHERE started_at IS NOT NULL;
