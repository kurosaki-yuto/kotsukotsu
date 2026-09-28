-- MCP の運用ルール(INSTRUCTIONS)を、各接続へ「バージョンごとに1回だけ」配信するための記録。
--
-- 指示文はプロトコル上 initialize でしか渡せないため、文面を編集しても既存の
-- 会話は古いルールのまま動き続ける。かといって毎回のツール応答に添付すると
-- 呼び出し側のコンテキストを圧迫する。そこで文面のハッシュ(version)を保存し、
-- 一致しない接続にだけ次のツール応答で1回添付する。
--
-- actor_key は個人トークンなら members の user id、ワークスペース共通キー接続なら
-- 'ws-key' が入る。
--
-- mcp-worker 側にも CREATE TABLE IF NOT EXISTS の遅延生成があるので、この
-- マイグレーションを流し忘れてもデプロイは動く(こちらは正規の記録用)。
CREATE TABLE IF NOT EXISTS mcp_instruction_delivery (
  ws_id        TEXT NOT NULL,
  actor_key    TEXT NOT NULL,
  version      TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (ws_id, actor_key)
);
