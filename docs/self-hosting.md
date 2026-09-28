# 自分の環境でこつこつを立ち上げる

こつこつは **使う人がそれぞれ自分のデプロイ先を作って動かす** 設計になっている。
このリポジトリにはデータベースもデプロイ先も入っておらず、共有のサーバーもない。
データベース (D1)・ファイル置き場 (R2)・Worker・シークレットは、すべて自分の
Cloudflare アカウントに作る。作るまで動かない。所要時間の目安は 30 分。

設定ファイルの `YOUR_SUBDOMAIN` / `YOUR_D1_DATABASE_ID` / `YOUR_VAPID_PUBLIC_KEY` は
自分の値に置き換えるための目印。置き換えずにデプロイすると動かない。

## 全体像

こつこつは Cloudflare Workers 上の 3 つの Worker で動く。

| Worker | ディレクトリ | 役割 |
|---|---|---|
| `kotsukotsu` | リポジトリ直下 | 画面・API・ログイン (Next.js + OpenNext) |
| `kotsukotsu-rt` | `realtime-worker/` | リアルタイム更新 (Durable Object + WebSocket) |
| `kotsukotsu-mcp` | `mcp-worker/` | Claude などの AI から操作する MCP サーバー。期限リマインダの Cron も持つ |

本体と MCP は同じ D1 と R2 を共有する。MCP から本体・リアルタイムへは service binding で呼ぶので、
**デプロイは `kotsukotsu-rt` → `kotsukotsu` → `kotsukotsu-mcp` の順** に行う。

## 0. 前提

- Node.js 20 以上
- Cloudflare アカウント (Workers の無料プランで動く。Durable Object は SQLite 版を使う)
- `npx wrangler login` 済み

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm install
(cd mcp-worker && npm install)
```

## 1. 自分の workers.dev サブドメインを確認する

Cloudflare ダッシュボードの Workers & Pages → 右側の「Subdomain」に出ている
`<サブドメイン>.workers.dev` の `<サブドメイン>` を控える。

リポジトリ内の `YOUR_SUBDOMAIN` をすべてそれに置き換える。

```bash
grep -rl YOUR_SUBDOMAIN --exclude-dir=node_modules . | xargs sed -i.bak 's/YOUR_SUBDOMAIN/<サブドメイン>/g'
find . -name '*.bak' -not -path './node_modules/*' -delete
```

置き換わる場所: `app/lib/series.ts` の `WORKERS_DEV`、`wrangler.jsonc`、`mcp-worker/wrangler.jsonc`。

## 2. D1 と R2 を作る

```bash
npx wrangler d1 create kotsukotsu-db
npx wrangler r2 bucket create kotsukotsu-files
```

`d1 create` が出力する `database_id` を、次の 2 か所の `YOUR_D1_DATABASE_ID` に貼る
(両方同じ値にする)。

- `wrangler.jsonc`
- `mcp-worker/wrangler.jsonc`

データベース名やバケット名を変えた場合は、両ファイルの `database_name` / `bucket_name` と、
`package.json` の `cf:migrate:*` スクリプト内の名前も合わせる。

## 3. テーブルを作る

```bash
npx wrangler d1 migrations apply kotsukotsu-db --remote
```

`d1-migrations/` の 0001 から順に適用される。

続けてバインディングの型を生成する (これが無いとビルドが型エラーで止まる)。

```bash
npm run cf:typegen
```

## 4. Web Push の鍵を作る

```bash
npx web-push generate-vapid-keys
```

- Public Key → `wrangler.jsonc` の `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT` → `mailto:` + 自分の連絡先
- Private Key → 次の手順でシークレットとして入れる

## 5. シークレットを入れる

値はどれも自分で作る。例: `openssl rand -hex 32`。
`RT_SECRET` と `PUSH_SECRET` は Worker 間で **同じ値** にする。

| シークレット | kotsukotsu | kotsukotsu-rt | kotsukotsu-mcp | 用途 |
|---|:-:|:-:|:-:|---|
| `RT_SECRET` | 要 | 要 | 要 | リアルタイム配信の認証 |
| `PUSH_SECRET` | 要 | | 要 | MCP から本体の Push 送信を呼ぶ認証 |
| `VAPID_PRIVATE_KEY` | 要 | | | Web Push の署名 |
| `MCP_TOKEN` | | | 要 | 管理者用の固定 MCP トークン |
| `OAUTH_SECRET` | | | 要 | claude.ai コネクタの OAuth 用の暗号鍵 |
| `RESEND_API_KEY` / `MAIL_FROM` | 任意 | | | パスワード再設定メール ([Resend](https://resend.com))。未設定なら送らない |
| `SSO_SECRET` | 任意 | | | こつこつシリーズの他製品と共通ログインするときだけ |

```bash
# realtime-worker には wrangler.jsonc だけがある。直下の wrangler を使う
npx wrangler secret put RT_SECRET --config realtime-worker/wrangler.jsonc

npx wrangler secret put RT_SECRET
npx wrangler secret put PUSH_SECRET
npx wrangler secret put VAPID_PRIVATE_KEY

cd mcp-worker
npx wrangler secret put RT_SECRET
npx wrangler secret put PUSH_SECRET
npx wrangler secret put MCP_TOKEN
npx wrangler secret put OAUTH_SECRET
cd ..
```

Worker がまだ存在しない段階で `secret put` すると、空の Worker を作ってよいか聞かれる。そのまま進めてよい。

## 6. デプロイする

```bash
npx wrangler deploy --config realtime-worker/wrangler.jsonc   # kotsukotsu-rt
npm run cf:deploy                                             # kotsukotsu (本体)
(cd mcp-worker && npm run deploy)                             # kotsukotsu-mcp
```

本体は `https://kotsukotsu.<サブドメイン>.workers.dev` で開く。

## 7. 最初のアカウントを作る

本体を開いて「新規登録」からメールアドレスとパスワードで登録する。
登録した人は自分用のワークスペースの管理者になる。ほかの人は設定画面の招待リンクから入れる。

## 8. Claude から使う (任意)

設定画面の「AI 接続」に出る URL を、claude.ai のコネクタ (カスタムコネクタ) に貼る。
Claude Code から使う場合は `mcp-worker/README.md` を参照。

## ローカルで動かす

```bash
npm run cf:typegen
npm run cf:migrate:local
npm run dev    # http://localhost:3939
```

ローカル用のシークレットは直下の `.dev.vars` に書く (`.gitignore` 済み)。

```
RT_SECRET=
PUSH_SECRET=
VAPID_PRIVATE_KEY=
```

## 独自ドメインを使う

Cloudflare ダッシュボードで `kotsukotsu` Worker にカスタムドメインを付ければそのまま動く。
リアルタイムと MCP の接続先は workers.dev のまま使われる。

## 困ったとき

- 画面は出るがデータが空: `database_id` が本体と MCP で食い違っていないか、マイグレーションを `--remote` で当てたかを確認する
- 他の端末に即時反映されない: 3 つの Worker の `RT_SECRET` が同じ値か、`RT_URL` のサブドメインが正しいかを確認する (15 秒ごとの再取得には戻る)
- スマホに通知が来ない: `VAPID_PUBLIC_KEY` と `VAPID_PRIVATE_KEY` が同じ組で作ったものかを確認する
