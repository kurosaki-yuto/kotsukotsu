# セキュリティ

## 脆弱性の報告

脆弱性を見つけたら、公開の Issue には書かず、GitHub の
[Report a vulnerability](https://github.com/kurosaki-yuto/kotsukotsu/security/advisories/new)
(Security タブ → Report a vulnerability) から非公開で知らせてください。
受け取ったら内容を確認し、直したら報告者と一緒に公開します。

## 自社専用版を安全に使うために

- 新規登録は、最初の1人 (管理者) のあとは招待リンクからしかできない (`wrangler.jsonc` の `SIGNUP_MODE`)
- ログインの失敗が続くと 15 分止まる (同じメールアドレスで 10 回、同じ接続元から 50 回)
- パスワードは 8 文字以上。PBKDF2 (SHA-256, 10 万回) で保存し、平文は残さない
- セッション Cookie は HttpOnly・Secure・SameSite=Lax
- `npm run setup` が作るシークレットは `.setup.json` と `.dev.vars` にだけ保存される (どちらも `.gitignore` 済み)。共有・コミットしない
- AI 接続のキー入り URL (設定 → APIキー) は鍵と同じ扱い。漏れたら同じ画面の「再生成」で無効にする
- アップデートは `git pull` → `npm run setup` で取り込む
