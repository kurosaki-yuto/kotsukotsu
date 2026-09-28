-- 型の意味での検索用。Workers AI (@cf/baai/bge-m3) で取った埋め込みを JSON 配列で持つ。
-- 言葉の重なりだけで選ぶと関係ない型が混ざったため (2026-09-28)。
-- 埋め込みが無い行は、検索のついでに取って埋める。モデルを変えたら embedding_model で見分けて取り直す。
ALTER TABLE playbooks ADD COLUMN embedding TEXT;
ALTER TABLE playbooks ADD COLUMN embedding_model TEXT;
