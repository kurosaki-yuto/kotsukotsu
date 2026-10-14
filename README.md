# こつこつ (kotsukotsu)

**コツれば終わる。**

ゴールを分ける。AI に任せる。人が決める。「やりたい」を「終わった」に変えていく、
人と AI のための実行管理アプリ。合同会社もちもつの自社プロダクト。

「何をやるか」ではなく「どのゴールの、どの完了基準を満たすためにやるか」から
タスクを分解して積む。人と AI (Claude / MCP) が同じ画面を正のソースとして共有する。

ホスト版: https://kotukotu.app (合同会社もちもつが運営)

## できること

- **ゴールとタスクを AI が読み書きする**: どのタスク (小タスク含む) にも「完了の基準」と「現状」(日付 / 済んだこと / ボール / 残り・詰まり) を持たせ、
  AI が MCP で読んで、作業ステップを登録し、終わるたびに結果を書き戻す。進行中 (誰のどの AI が手を動かしているか) も出る
- **AIで進める**: タスクを開いて押すと、そのタスクの指示文が入った状態で Claude Code / Codex / claude.ai が開く。
  スマホは指示文が落ちないようブラウザで開く版と、Claude アプリで開く版を選べる
- **連携ガイド (設定 → 連携ガイド)**: こつこつ本体は外部ツールと直接は繋がらない。Chatwork・Gmail・カレンダー・ドライブ・Notion・GitHub・Zoom は
  AI の側に繋ぎ、AI が読んで現状に書く。繋ぎ方・「AI にまとめて入れてもらう」(Claude Code に頼んで接続とプラグインを入れる)・
  「何を足すとよいか診断」のボタンと、使い方のコラム (/column) がある
- **型 (テンプレート)**: 必要な入力値 + 資料リンク + タスクの木を型にして、メンバーを選んで振ると新しいゴールごと丸ごと入る (/templates)。終えたゴールの「…」→「型にする」で作れる
  型は仕事に要るナレッジの入口で、本文は持たない。資料 (やり方・実物・置き場所・情報源の URL と「何のために見るか」)・注意点・結んだ前例を持ち、
  AI がタスクに入るとき (get_goal / start_task) と終えるとき (complete_subtask) に渡る。差し戻しが入ると AI が注意点を足して型が育つ (直した履歴から戻せる)。
  `KATA_GITHUB_REPO` / `KATA_GITHUB_TOKEN` を設定すると、型を直すたびに GitHub へ Markdown で書き出す (こつこつが止まっても型が残る)
- **前例 (playbook)**: 終えたタスクのやり方を残すと、似たタスクに次の AI が取りかかるときに前例として渡る
- **通知・@メンション・コメント・ファイル添付・メンバーごとの担当範囲**

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
│   ├── api/                 # ルートハンドラ (goals, templates, auth, chat, files, push, mcp-token ...)
│   ├── components/          # AppShell / RealtimeBridge / tasks (タスク画面の行) / goal (ゴール詳細の部品) ほか
│   ├── lib/
│   │   ├── db.ts            # 画面とサーバーで共有する型
│   │   ├── addness.ts       # 画面から /api を呼ぶ関数 (全部 api() 経由。失敗はバナーに出る)
│   │   ├── hosts.ts         # Worker が動いている workers.dev のサブドメイン
│   │   └── server/          # サーバー側: queries/ (領域ごとの D1 読み書き)・auth・workspace・ratelimit・filesCore・templateCore・compare
│   ├── goals/ members/ notifications/ settings/ templates/ login/ reset/
│   └── page.tsx             # タスク画面 (ツリー)
├── d1-migrations/           # 0001〜0026。D1 のスキーマはここが正。足すだけ (AGENTS.md)
├── mcp-worker/              # MCP サーバー (別 Worker)。src/tools/ に領域ごとのツール、lib.ts に共有部品、instructions.ts に運用ルール
├── realtime-worker/         # リアルタイム配信 (別 Worker)
├── node-server/             # Docker 版 (同じコードを SQLite + ディスクで動かす)
├── scripts/                 # setup / update / security-smoke (自社環境への診断)
├── docs/                    # 使い方ガイド・self-hosting・セキュリティ監査
└── wrangler.jsonc           # D1 / R2 / vars バインディング
```

## セットアップ

データベース・デプロイ先は、使う会社・人がそれぞれ自分の Cloudflare アカウントに作る。
`npm run setup` が D1 の作成からシークレット、3 つの Worker のデプロイまで1回でやる。
同じ名前の Worker・データベースが既にあれば上書きせずに止まる。
無料プランで動く。

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm install
npm run setup -- --name acme-kotsukotsu   # 名前は会社・チームごとに決める。終わると URL が出る
```

Claude Code などの AI に「立ち上げて」と頼めば、`AGENTS.md` の手順どおりに進めてくれる。

Cloudflare 以外 (AWS・Google Cloud・社内サーバーなど) で動かすときは Docker 版: `npm run setup:docker` ([docs/self-hosting-docker.md](./docs/self-hosting-docker.md))。

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
