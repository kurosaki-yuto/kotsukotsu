-- 型 (テンプレート) をナレッジの入口にする (docs/plans/2026-10-14_型をナレッジの入口にする.md)。
-- こつこつが持つのは URL・1 行の説明・注意点の短文だけ。本文 (手順書・実物・情報源) は外に置く。
--
-- resources の 1 件は {kind, name, url, why} に広げる (列は増やさず JSON の中身だけ。古い {name, url} は kind=情報源 として読む)。
-- cautions: 注意点。[{text, source_goal_id, source_comment_id, added_at, added_by}]。どの差し戻しから来たかを辿れるようにする。
ALTER TABLE templates ADD COLUMN cautions TEXT NOT NULL DEFAULT '[]';
-- タスクに近い型を選ぶための埋め込み (前例と同じ bge-m3、int8 を base64)。型を直したら NULL に戻して取り直す。
ALTER TABLE templates ADD COLUMN embedding TEXT;
ALTER TABLE templates ADD COLUMN embedding_model TEXT;
-- 型を外 (GitHub) に書き出した先。こつこつが止まっても、ここから資料に辿れる。
ALTER TABLE templates ADD COLUMN export_url TEXT;
ALTER TABLE templates ADD COLUMN exported_at TEXT;

-- 型を直した履歴。直すたびに 変更前・変更後 を丸ごと残し、1 回で戻せるようにする。
-- 修正は AI が自動で反映する (黒崎判断 2026-10-14) ので、誰が・なぜ直したかを必ず残す。
CREATE TABLE IF NOT EXISTS template_revisions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  template_id   TEXT NOT NULL,
  before_json   TEXT NOT NULL,   -- 直す前の型 (name, purpose, completion_criteria, inputs, tasks, resources, cautions)
  after_json    TEXT NOT NULL,   -- 直した後の型
  reason        TEXT,            -- なぜ直したか (差し戻しの要約など)
  source_goal_id    TEXT,        -- 直すきっかけになったゴール
  source_comment_id TEXT,        -- 直すきっかけになったコメント
  actor_name    TEXT,
  actor_kind    TEXT NOT NULL DEFAULT 'human', -- human / ai
  created_at    TEXT NOT NULL,
  reverted_at   TEXT,            -- この版を戻した日時 (戻した操作自体も新しい版として残る)
  reverted_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_revisions_tpl ON template_revisions(workspace_id, template_id, created_at);

-- 前例を型の「やり方」として結ぶ (黒崎判断 2026-10-15)。結んだ前例は型を開くと一緒に出る。
ALTER TABLE playbooks ADD COLUMN template_id TEXT;
CREATE INDEX IF NOT EXISTS idx_playbooks_template ON playbooks(workspace_id, template_id);
