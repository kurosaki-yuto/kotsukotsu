# 「今日何したらいいの?」エンジン

MCP ツール `whats_next` / `commit_today` / `dismiss_suggestion`。
Claude に「今日何したらいい?」と聞くと、根拠付きの候補が返り、そこから3つを選んで確定できる。

## なぜ作ったか — 動いていなかった線

`today_date` は **使われていない方のテーブルに付いていた**。

| モデル | テーブル | 状態 |
|---|---|---|
| ゴール=タスク (`parent_goal_id` で入れ子) | `projects` | 生きている。`/` と `/goals/[id]` が描画しているのはこれ |
| アウトライナー | `nodes` | UI から切れている。`Outliner.tsx` / `Sidebar.tsx` はどこからも import されていない |

`list_today` / `/api/today` / due リマインド cron はすべて `nodes` を見ていたので、
`list_today` は常に 0 件を返していた。**データが無かったのではなく線が繋がっていなかった。**

2026-09-16 の実測 (`workspace_id='default'`):

| 指標 | 値 |
|---|---|
| アクティブな goal | 688 |
| うち子を持たない = 実行単位のタスク | 556 |
| 黒崎にアサインされた実行単位タスク | 229 |
| `deadline` が入っているもの | 19 / 556 |
| `completion_criteria` が書かれている goal | 501 |
| `current_state` が書かれている goal | 503 |
| 直近14日の `chat_messages` | 297 |

期限では並べられない (19本しかない)。代わりに完了基準と現状が500本ずつ埋まっているので、そこから導く。

## 3段構成

| 段 | 何を | どこで | コスト |
|---|---|---|---|
| 1. 絞り込み | 229 → 上位12にスコアリング | `today/score.ts`、SQL + TS、決定的 | 0 |
| 2. 具体化 | 各候補を「30秒で着手できる1文」に | **既定は呼び出し側の Claude** (`goal_context` を渡す)。`server_side_action: true` のときだけ `today/next-action.ts` で Haiku 4.5 | 既定 0 |
| 3. 選抜 | 12件から今日の3つを決める | **呼び出し側の Claude** | 0 |

**段2・段3をサーバーでやらないのが既定。** 呼んでいるのが Claude 自身なので、
ゴールの `completion_criteria` / `current_state` / 直近コメントを `goal_context` として
渡せば、呼び出し側が自分で「今日の一手」を書ける。Haiku より賢いモデルが、しかも
カレンダー・アポ・直前の会話まで見た上で書くので質が高く、API キーも課金も要らない。
サーバーは「根拠付きの候補一覧 + 判断材料」までを担う。

`server_side_action: true` は、呼び出し側に AI が居ない経路 (アプリ画面・朝のプッシュ通知)
のためにある。そのときだけ `ANTHROPIC_API_KEY` が必要。
返り値の `next_action_source` が `"caller"` / `"server"` のどちらだったかを示す。

外部シグナル (アポ・予定) は `available_minutes` / `context` 引数で呼び出し側が渡す。

### 段1 のスコア

重みは `today/score.ts` の `WEIGHTS` 1箇所にまとまっている。内訳は必ず
`items[].signals` で返す — 内訳を見せられないスコアは調整できない。

| シグナル | 点 | 根拠 |
|---|---|---|
| `deadline` | 0〜40 | 自分または祖先の期限。祖先は1階層ごとに ×0.6 減衰。期限切れは満点維持 |
| `placement` | 0〜12 | 役割箱 (最上位の1つ下) の `order_idx`。人が手で上に置いた意思表示 |
| `nearlyDone` | +15 | 兄弟の残りが1〜2件、または親の完了基準の残り `□` が1〜2本 |
| `momentum` | +15 | 3日以内にそのゴールで会話がある |
| `stalled` | +10 | 30日以上動いていない (放置の止血) |
| `justCreated` | -10 | 作成から24時間以内 |
| `dismissed` | -25 | 直近7日に `dismiss_suggestion` された |
| `carriedOver` | +30 | 前日 `commit_today` したのに終わっていない |
| `crowded` | -8 / -16 | 同じ親ゴールからの2件目 / 3件目以降 |

`placement` を「最上位」ではなく「役割箱」で見るのは実測の結果。黒崎のツリーは最上位が
「年商1億の企業にする」1本なので、最上位を見ると 233件全部に満点が付いてただの定数になった。

`crowded` も実測から入れた。入れる前は「野村工務店」の4タスクが同点で1〜4位を占め、
今日の3つが1案件だけになっていた。

### 段2 のキャッシュ

キャッシュキー = SHA-256 の対象:
タスク名 / 自分と親の `completion_criteria` / 同じく `current_state` / 最新コメント時刻 /
兄弟の完了数 / 直近の期限 / モデル名。

ゴールが動かない限り再推論しない。実運用で毎日叩くのは前日から変わった数件だけ。
`whats_next` の返り値の `llm_calls` が実際に叩いた回数なので、キャッシュが効いているかは
2回続けて呼べば確認できる (2回目は 0 になる)。

Haiku 4.5 は $1 / $5 per MTok。12件 × (約2.5k in + 250 out) で1回あたり約 $0.045。

## 落ちたときの挙動 (AGENTS.md #1)

`server_side_action: true` で呼んだのに `ANTHROPIC_API_KEY` が未設定・拒否・レート制限・
到達不能だった場合、**候補を空にしない**。タスク名そのままの候補を返し、`degraded` に
理由を入れる。既定 (`caller`) の経路では LLM を使わないので `degraded` は常に null。

```json
"degraded": {
  "reason": "anthropic_api_key_unset",
  "detail": "ANTHROPIC_API_KEY が未設定のため、次の一手の具体化をスキップしました。…"
}
```

「AI が死んでいる」と「今日やることが無い」が同じ見た目になってはいけない。

1件でも失敗したら残りの LLM 呼び出しは打ち切る (キー不正やレート制限なら残りも同じく落ちる)。

## データ品質のフライホイール

現状が古い/空で今日の一手を決める根拠が足りない候補は、`items` ではなく `stale_goals` に
入る。判定は2系統。

1. **決定的 (API キー不要)**: 現状が空、または現状の先頭にある「YYYY-MM-DD時点」が
   30日以上前。こつこつの現状は「(1) 何日時点か」を必ず書く規約なので、これが
   書式チェック兼鮮度判定になっている。
2. **LLM (`server_side_action: true` のときだけ)**: 段2 の出力の `state_is_stale`。

呼び出し側は最後に「現状が古くて判断できなかったものが N 件ある。`update_goal` で現状を
書けば明日から候補に入る」と伝える。**ツールを使うほど現状が埋まる**形にしてある。

## スキーマ (`d1-migrations/0019_today_engine.sql`)

| 追加 | 用途 |
|---|---|
| `projects.today_date` | 生きているモデル側の「今日やる」。`commit_today` が書く |
| `projects.completed_at` | いつ終わったか。速度と「提案は実行されたか」の測定に必要 |
| `today_briefs` | 出した提案のスナップショット + 採用/却下/完了の印 |
| `goal_next_action` | 段2 の LLM キャッシュ (goal 1件1行) |

**`projects.completed_at` は既存の done 行 (2,000件超) には入っていない。** 記録が存在しない
ので埋めると嘘になる。`complete_subtask` を通った今後の完了分だけ入る。

## `list_today` / `set_today` の変更

`nodes` 専用から `projects ∪ nodes` に広げ、各行に `type: "goal" | "node"` を付けた。
列名は揃えてあるので、`type` を見ない既存の呼び出し (`/chat` の今日タブ) はそのまま動く。

`set_today` は `id` を受け取り、先にゴールとして探して無ければ node として扱う。
旧引数名 `nodeId` も受け付ける。

## 「今日」の日付は UTC で出さない

以前の `todayIso()` は UTC 固定だったので、JST の朝9時より前は前日を返していた。
`workspaceToday()` (`today/score.ts`) が `workspaces.timezone` (既定 `Asia/Tokyo`) で
解釈する。この列はそれまでどの cron からも読まれていなかった。

## 運用

```bash
# API キーの設定 (段2 を有効にする)
cd mcp-worker && npx wrangler secret put ANTHROPIC_API_KEY

# デプロイ
cd mcp-worker && npx wrangler deploy
```

疑うときの確認順:

1. `whats_next` の `candidate_pool` — 0 ならアサインが無い (`goal_members`) か全部子を持っている
2. `pool_truncated` が true — 候補が上限 400 に当たっている。母数が多すぎるので `focus` で絞る
3. `degraded` — LLM 側の問題。`detail` に対処が書いてある
4. `llm_calls` が毎回 12 — キャッシュが効いていない。`goal_next_action.cache_key` を疑う
5. `items[].signals` — 順位が納得できないときはここを見て `WEIGHTS` を直す

## まだ作っていないもの

- `/today` 画面 (アプリ UI)。今は MCP のみ
- 朝のプッシュ通知。`isDailySelfCheckTick` (mcp-worker の `scheduled`) にぶら下げれば足せる。
  ただしあの判定は UTC 00:00 固定なので、`workspaces.timezone` を見るように直す必要がある
- サーバー側での外部シグナル取得 (apo-board / marketing / カレンダー)。今は呼び出し側が渡す
