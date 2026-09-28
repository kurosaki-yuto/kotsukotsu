# こつこつ (kotsukotsu)

ゴール起点の ToDo・実行管理アプリ。合同会社もちもつの自社プロダクト。

「何をやるか」ではなく「どのゴールの、どの完了基準を満たすためにやるか」から
タスクを分解して積む。人と AI (Claude / MCP) が同じ画面を正のソースとして共有する。

ホスト版: https://kotukotu.app (合同会社もちもつが運営)

## アーキ

- フロント: Next.js 16 App Router + React 19 + Tailwind v4
- ホスト: Cloudflare Workers (`@opennextjs/cloudflare`)
- DB: Cloudflare D1 (`kotsukotsu-db`)
- ファイル: Cloudflare R2 (`kotsukotsu-files`)
- リアルタイム: 別 Worker (`realtime-worker` / Durable Object)
- 認証: メール + パスワード。セッション Cookie
- Push: Web Push (VAPID)
- AI 連携: `mcp-worker` が MCP サーバー。Claude から `list_goals` / `add_subtask` /
  `complete_subtask` / `send_chat` などを直接叩ける

## ディレクトリ

```
.
├── app/
│   ├── api/                 # ルートハンドラ (goals, subtasks, auth, chat, push, mcp-token ...)
│   ├── components/          # AppShell / Outliner / Sidebar / ChatDock / RealtimeBridge
│   ├── lib/
│   │   ├── db.ts            # D1 アクセス
│   │   ├── queries.ts       # CRUD (insert/update/delete/indent/outdent/archive)
│   │   ├── hosts.ts         # Worker が動いている workers.dev のサブドメイン
│   │   └── server/          # サーバー側ユーティリティ (セッション・認可)
│   ├── goals/ members/ notifications/ settings/ chat/ history/ login/ reset/
│   └── page.tsx             # Sidebar + Outliner + Cmd+K パレット
├── d1-migrations/           # 0001〜0019。D1 のスキーマはここが正
├── mcp-worker/              # MCP サーバー (別 Worker)
├── realtime-worker/         # リアルタイム配信 (別 Worker)
├── docs/kotsukotsu-guide.md # 使い方ガイド
└── wrangler.jsonc           # D1 / R2 / vars バインディング
```

## セットアップ

データベース・デプロイ先は、使う人がそれぞれ自分の Cloudflare アカウントに作る。
`npm run setup` が D1 の作成からシークレット、3 つの Worker のデプロイまで1回でやる。
無料プランで動く。

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm install
npm run setup     # 終わると https://kotsukotsu.<サブドメイン>.workers.dev が出る
```

Claude Code などの AI に「立ち上げて」と頼めば、`AGENTS.md` の手順どおりに進めてくれる。

詳しくは [docs/self-hosting.md](./docs/self-hosting.md) (料金・あとから足せるもの・消し方・手で立ち上げる場合)。

ローカル開発:

```bash
npm run cf:typegen         # バインディングの型を生成
npm run cf:migrate:local   # ローカル D1 にマイグレーション適用
npm run dev                # http://localhost:3939
```

## キーバインド

| キー | 動作 |
|------|------|
| `Enter` | 同階層に新規行 |
| `Tab` | インデント |
| `Shift+Tab` | アウトデント |
| `Cmd/Ctrl+Enter` | 完了 (アーカイブ + 画面から消える) |
| `↑/↓` | 行間移動 |
| `Backspace` (空行) | 行削除 |
| `Cmd/Ctrl+K` | プロジェクト切替 |

iPhone は画面下部のツールバーから操作 (⇤ ⇥ +行 ✓完了)。PWA としてホーム画面に追加できる。

## MCP (Claude 連携)

`mcp-worker/` が MCP サーバー本体。設定と使えるツールの一覧は
`mcp-worker/README.md` を参照。接続トークンはアプリの設定画面から発行する
(`/api/me/mcp-token`)。

## データバックアップ

```bash
wrangler d1 export kotsukotsu-db --remote --output backup-$(date +%F).sql
```

## ライセンス

[MIT](./LICENSE) © 合同会社もちもつ
