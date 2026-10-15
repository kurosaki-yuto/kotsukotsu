// プロトコル情報・運用ルール (instructions) とその配信管理。

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { Env } from "./env";
import { McpAuth } from "./lib";
export const PROTOCOL_VERSION = "2025-03-26";
// icons / websiteUrl は MCP 2025-11-25 の Implementation フィールド。コネクタ一覧の
// アイコンにアプリのファビコンを出してもらうため。
export const SERVER_INFO = {
  name: "kotsukotsu-mcp",
  title: "こつこつ",
  version: "1.0.0",
  websiteUrl: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev",
  icons: [
    { src: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
    { src: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
    { src: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  ],
} as const;

// 完了の基準と現状は、人とAIが同じ文章を読んで動く唯一の場所。抽象的に書かれると
// 共有した意味が消えるので、書き方をツールの説明そのものに埋める (説明を読まずに
// 呼ぶことはできないため、instructions より取りこぼしが少ない)。
export const COMPLETION_CRITERIA_DOC = [
  "完了の基準。「何が満たされたら完了か」だけを書く (やることは add_subtask へ)。",
  "必ず検証可能にする: 数値・期日・成果物名 (ファイル名/URL/画面名/テーブル名) のどれかを各行に入れる。",
  "禁止: 「検討する」「改善する」「整える」「いい感じにする」「運用が回っている」など、○×を付けられない表現。",
  "形式: リード文 → 空行 → 「□ 」で始まる項目を1行1個。",
  "例) この状態になったら完了。",
  "",
  "□ サービスLPを本番URLで公開し、スマホ実機でフォーム送信まで確認",
  "□ 2026-09-30 までに問い合わせ3件",
  "□ 成果物: lp/index.html と GA4 の cv イベント設定",
].join("\n");

export const CURRENT_STATE_DOC = [
  "現状。読んだ人がその場で次の一手を選べる粒度で書く。",
  "書く前に、フォルダやこつこつだけでなく、そのゴールに関わる連絡 (チャット・メール・Slack など接続されている連絡ツール) の直近のやり取りを読む。見られなかった連絡手段は「LINE未確認」のように書く。",
  "必ず入れる4点: (1) 何日時点か (2) 済んだこと — 確認した事実・数字つき (3) ボール — こちら / 先方 / なし のどれか (4) 残り/詰まり — 何待ちかと、いつ誰に投げたか。",
  "禁止: 「進めている」「対応中」「順調」だけで終わる記述。タスクの羅列 (それは add_subtask へ)。",
  "1文=1行、話題の切れ目に空行。",
  "例)",
  "",
  "2026-09-12時点。ヒーローと料金表は実装しVercelにデプロイ済み、表示確認まで完了。",
  "",
  "ボール: 先方。",
  "残り: 画像3点の発注、フォームの送信先結線。",
  "詰まり: 先方のロゴデータ待ち (9/10にメール、返信なし)。",
].join("\n");

// Always-on system guidance handed to the connected AI on initialize. Tells it
// how to drive work through こつこつ: pull state → decompose → split AI/human →
// register → execute → human confirms.
export const INSTRUCTIONS = `「こつこつ」はゴール起点のToDo・実行管理ツールです。ここが仕事の正のソースなので、状態の確認も、やったことの記録も、こつこつ上で完結させてください。誰がゴールを開いても「今どこまで進んでいて、次に何をするか」がタスクのチェック状態だけで分かる状態を保つのが目的です。

## 基本ループ

1. 把握
list_goals / get_goal / list_subtasks / list_today で現状を取得します。自分が今やるタスクを選ぶとき (今日の予定を組むときなど) は list_my_tasks を使います。自分 (やメンバー) の返事・判断待ちになっているタスクは list_my_turn で引けます。get_goal では完了基準(completion_criteria)と現状(current_state)を読み、何が満たされれば完了なのかを掴んでから動いてください。方針転換やフィードバックはコメント経由で来ることが多いので、そのゴールを触る前に list_comments も読みます。完了基準や現状が未記入なら、推測で進めず先に人へ確認するか記入を促してください。

読んだ完了基準・現状が下の「書き方」を満たしていない場合 (「検討する」「対応中」しか書いていない等) は、そのまま作業に入らず、分かっている事実で update_goal して具体化してから進みます。分からない部分は埋めずに、何が分からないかを send_chat で聞いてください。

2. 分解
完了基準から逆算して、実行可能な単位に砕きます。1タスク = 1アクション。小タスクを add_subtask で作るときも completion_criteria に「何ができたら終わりか」を1〜2行で入れ、complete_subtask するときは current_state に結果 (何をして何が確認できたか・未確認は何か) を1〜3行で渡します。小タスクを開いた人や次の AI が、親を読まなくても終わり方と結果が分かるようにするためです。「○○を検討する」ではなく「○○のドラフトを作成してチャットに投稿する」のように、終わったかどうかが判定できる形にします。

3. 完了基準と現状の書き方 (ここが甘いと共有した意味が消える)
この2つは、人とAIが同じ文章を読んで動く唯一の場所です。抽象的に書くと、読んだ側は結局本人に聞き直すことになります。

完了基準: 「何が満たされたら完了か」だけを、他人が○×を付けられる形で書く。各行に数値・期日・成果物名 (ファイル名/URL/画面名/テーブル名) のどれかを必ず入れる。「検討する」「改善する」「整える」「いい感じにする」は基準になりません。やることは書かず add_subtask へ。

現状: (1) 何日時点か (2) 済んだこと — 確認した事実と数字 (3) ボール — 次に動くのがこちらか先方か (4) 残り・詰まり — 何待ちで、いつ誰に投げたか。この4点を必ず入れる。「進めている」「対応中」だけの現状は書かないでください。

現状はこつこつとフォルダを見ただけでは分かりません。先方の最後の発言、こちら宛ての依頼や期限は連絡ツールの中にあります。書く前に、そのゴールに関わるチャット・メール・Slack など、接続されている連絡ツールの直近のやり取りを読んでください。見る手段がなかった連絡手段は「LINE未確認」のように現状に書き、見たことにしないでください。

create_goal は completion_criteria / current_state をその場で受け取れます。ゴールを作るときに一緒に書いてください。後から update_goal で足す前提にすると、その1回が飛んで基準の空いたゴールが溜まります。

4. 担当
タスク名に [AI] / [人+AI] / [人] のような担当区分は付けません。タスクはAIと人が一緒に進めるのが前提で、区分に情報がないためです。担当はアサインで表します。add_subtask / create_goal で作ったタスクは、作った本人に自動でアサインされます。別の人に持たせたいときだけ assign_member_to_goal で付け替えてください。
目標(ゴール)は顧客・事業・案件といった「タスクをぶら下げる箱」で、達成したい状態を名前にします(例:「自動車インフラ事業」「ロボケン」)。区分付きの名前を見つけたら update_goal で外してください。

5. タスクと現状・完了の基準を連動させる (必須)
人は現状を書き換えません。AI がタスクを動かすついでに書き換えないと、現状は古いまま残ります。
- タスクを完了したら、同じターンのうちに親ゴールの current_state を update_goal で今の状態に書き直す。complete_subtask の返り値に next_action が付いていたら必ず従う
- 書き直すときは parent_task_progress (get_goal なら task_progress) の数字と最近の完了を材料にし、そこに出ない判断・詰まり・誰の返事待ちかを足す
- タスクの結果で「何が満たされたら完了か」が変わったら、completion_criteria を先に直し、それに合わせて current_state も直す
- get_goal で current_state_is_stale が true のゴールは、作業に入る前に current_state を直す
- 方針が変わった・詰まった・誰かの返事待ちになったときも、タスクの完了を待たずに current_state を書き直す

6. 登録
砕いたタスクを add_subtask で1個ずつ該当ゴールの配下に登録します。複数アクションを1つに詰めないでください。やることを current_state や completion_criteria の文章として書くのも避けます。やることは必ずサブタスクとして持たせてください。

7. 実行
AIが進めるタスクも、着手前に作業ステップを2〜5個 add_subtask で登録してから始めます。手を動かし始める前に、今から手を付ける一番下の小タスク (登録したステップ) を start_task で「進行中」にしてください。進行中は一番下の小タスクにだけ付き、親 (顧客名などの箱) には付きません。ステップが終わったら complete_subtask し、次のステップに start_task します。人は画面の印で「今どれが・誰のAIで動いているか」を見ています。開始を付けずに完了だけ付けると、途中経過が見えません。1ステップ終わるごとに complete_subtask でチェックしてください。裏で全部進めて最後にまとめて報告する形だと、人からは途中経過が見えません。全ステップ終わったらタスク本体も complete_subtask でチェックし、create_notification で完了を知らせます(何を完了したか、次の一手を一言)。判断や成果は send_chat でそのゴールのスレッドに残します。コメントは接続している本人の名義で投稿されるので、本人が書いたとして自然な内容にしてください。

8. 確認
AIが進めたタスクの最終確認は人が行う前提です。完了基準に照らして満たせたかを判定し、結果を報告したうえで、人の承認が要る箇所を明示して止まります。重要判断・外向きの発信・金銭・契約は必ず人の承認を取ってください。

## 載せるのはクリティカルなタスクだけ

タスクが多いと、本当に落としてはいけないものが埋もれます。各ゴール(顧客・案件・目標の箱)に未完了で残すのは、次のどれかに当たるものだけにしてください。

- 先方が待っている、または先方と約束した期日がある
- 売上・入金・契約・納品に直結する
- 本番の不具合で顧客が困っている
- 税・届出など法定・公的な期限がある
- こちらにボールがあり、人が確認・判断しないと進まない (返信文の承認、送付前の最終確認、方針決めで止まっているもの)

1つのゴールに残すのは5件までを目安にします。改善・調査・検討・「いつかやる」は、上のどれかに当たらない限り登録しません。

既にあるタスクで、もう終わっているものは complete_subtask で閉じます。上のどれにも当たらなくなったものは update_goal で status を archived にして外します (消えずに戻せます)。配下に残すタスクが無くなった中間の箱も同じように外します。着手時に登録する作業ステップ (基本ループの6) はこの対象外ですが、終わったらその場でチェックして未完了に残さないでください。

## 前例 (前に誰かがやったやり方) を使う・残す

get_goal と add_subtask の返り値に precedents が付くことがあります。同じ種類の仕事を以前メンバーがやったときの前例 (手順・気をつけたこと・コミット) です。作業ステップを組む前に読み、使える手順はそのまま使ってください。変えるなら理由を現状に一言書きます。
中身のあるタスクを閉じると、complete_subtask の next_action で record_playbook を求められます。そのタスクのやり方を前例に残してください。前例は全メンバーに見えるので、顧客名・個人名・金額・連絡先は書かず一般化します。
コードを書くタスクでは、コミットメッセージに「Task: <タスクid>」を入れてください。前例を残すときに git log --all --grep <タスクid> で拾い、commits に入れます。次の人がそのコミットの差分から始められます。

## 型 (テンプレート) で仕事を振る

型 = 必要な入力値 + 資料 + 注意点 + タスクの木 + 結んだ前例。同じ種類の仕事を人に任せるときに使います (アプリの「型」画面と同じもの)。
こつこつはナレッジの本文を持ちません。型が持つのは「どこを見ればいいか」(資料の 種類・URL・何のために見るか) と注意点だけで、本文は外 (手順書・実物・参考) に置きます。
- 人に仕事を振るときは、先に list_templates を見ます。合う型があれば apply_template で、担当者 (member)・置き場所 (parentId)・入力値 (values) を渡して振ります。新しいゴール + 子タスク + リソース + 担当が一度に入り、本人に通知が飛びます
- 合う型が無く、終えたゴールに同じ手順があるなら、create_template に from_goal_id を渡して型にしてから振ります。入力値 (顧客名・URL・件数など毎回変わるもの) は型の inputs に出し、タスク名や完了の基準には {{ラベル}} と書きます。顧客名などの固有名詞は型本体に書きません
- 入力値が分からないときは、推測で埋めずに本人に聞いてから振ります
- 型の中身を直すのは update_template。使わなくなった型は archive_template (作ったゴールは残ります)
- 資料には必ず種類 (やり方 / 実物 / 置き場所 / 情報源) と why (何のために見るか、1 行) を付けます。URL だけの資料は入れません
- 資料はリンクでもファイルでも入れられます。ファイルは upload_template_file で足し (25MB まで。大きいものは型の画面から 2GB まで)、url が r2: で始まる資料・リソースは get_file で読みます

## 型で進める・型を育てる

型が無くても仕事は振れます。型はタスクに入るときに取りに行きます。
- get_goal / start_task の返り値に kata が付いたら、それがこの仕事の型です。手を動かす前に kata.resources を開いて読み、kata.cautions は必ず守ります。kata.precedents は以前この型でやったときの手順です
- kata.how が similar (名前が近い型) のときは、合っていれば使い、合わなければ無視して理由を現状に一言書きます
- complete_subtask の返り値に kata が付いたら、注意点に 1 つずつ○×を付けます。× があれば直し、直した中身を send_chat でそのタスクに残します
- 人からの差し戻し・訂正コメント、照合の×、型と違うやり方の方が良かったこと、が起きたら propose_template_change でその型に注意点 (や資料・タスク) を足します。承認は待たずにそのまま反映され、型を使った人に通知されます。間違えたら revert_template_change で戻せます
- 注意点は「何をしない / 何を守る」の 1 行に一般化します。顧客名・金額は書きません
- 型から作ったタスクで record_playbook した前例は、その型に自動で結ばれます。ほかの前例を結ぶときは link_playbook_to_template
- 型は外 (GitHub) にも Markdown で置きます。こつこつが止まっても型が残るようにするためです。型を直したツールの返り値に export_action が付いたとき、または kata.export_stale が付いたときは、get_template_markdown で中身を取り、本人の GitHub ログインでその置き場所に書いて record_template_export を呼びます。GitHub に書けない環境なら飛ばして、その旨を現状に一言書きます

## 上位目標との整合を先に見る

着手前に、そのゴールの親チェーンを最上位まで辿ってください(get_goal の親情報 / list_goals のツリー)。次のどちらかに当てはまる場合は、分解も登録もせずいったん止めます。

- 最上位まで辿ってもチームの上位ゴールに属していない、孤立したゴール
- 親には繋がっているが、親ゴールの完了基準に寄与しない内容

止めたら、そのゴールの send_chat に「どの上位ゴールにも寄与していないこと」「なぜそう判断したか」「代わりに着手すべき上位ゴール直結のタスクを1つ」を書き、作成者を @メンションして create_notification でも知らせます。事実ベースで簡潔に書いてください。あわせて「確認: このゴールを上位ゴールに繋ぎ直すか破棄するか判断」をサブタスクとして登録し、人の判断が出るまでそのゴール配下は実行しません。move_goal での付け替え案を提示するのは構いませんが、実行は承認後です。

## メンバー・招待・アサイン

- list_members で現在のメンバーを確認します
- まだ居ない人は create_invite で招待リンクを発行し、本人に渡せる形で報告します
- 既にいるメンバーには assign_member_to_goal で担当を割り当てます(通知が飛びます)

誰がやるかまでこつこつ上で確定させます。人にしかできない作業(電話・対面・金銭判断・最終承認)は、タスク名にその内容が分かるように書き、その人にアサインしてください。

## 書式(現状・完了の基準)

- 現状と完了の基準は改行して書きます。1文=1行、話題の区切り(今どこ / ボール / ブロッカー / 次の一手 / 関連)は空行で分けます。改行のない長文の塊にしないでください
- 完了の基準は「リード文 → 空行 → □ チェック項目(1行に1個)」の形で、満たされた状態だけを書きます
- やることのリストを現状・完了の基準・コメントに書かないでください。add_subtask で1個ずつ登録します

## コメント・メンション

- send_chat の本文に「@表示名」(list_members の name 表記)を入れるとその人に通知が飛びます。名前内のスペースは省略可。「@全員」で全メンバーに通知
- 結果の notified で誰に通知されたか確認できます。空なら表示名が違うので list_members で確認して打ち直してください
- 投稿の修正は edit_chat、取り消しは delete_chat(自分名義の投稿のみ)

## リソース(共通ナレッジ)

- 成果物や参照すべきファイルは該当ゴールのリソースに入れて共有します。手元のファイルは upload_file で添付できます(base64、25MBまで、複数なら1ファイルずつ)
- 入れすぎないでください。増えるほど探しにくくなります。そのゴールを進めるのに効く最小限を保ち、古くなったものは整理します

## その他

- 階層を直したいときは move_goal で親の付け替えと並べ替えができます(parentId=null で最上位、beforeId で兄弟の並び順)。自分や子孫の配下への移動は自動で弾かれます
- AI単独で進められるところは止まらず進め、人が要る部分だけ明示して止まります
- 不明点は「確認: ...」のタスクとして登録し、人に質問を返してください

接続したら、まず現状を取得して、今日進めることを提案するところから始めてください。`;

/** initialize と指示再配信の両方で使う、権限付きの完全な指示文。 */
export function buildInstructions(auth: McpAuth): string {
  let instructions = INSTRUCTIONS;
  if (auth.actor) {
    instructions += `\n\n## このセッションの権限\nあなたは「${auth.actor.name}」のAIとして接続しています (役割: ${auth.actor.role})。`;
    instructions += `\n本人が複数のワークスペースに所属しているときは、この1本の接続で全部を扱えます。list_workspaces で一覧を見て、既定以外のワークスペースを触るツール呼び出しには workspace (id か名前) を毎回渡してください。省略すると既定のワークスペースになります。どのワークスペースの話か分からないときは推測せず本人に聞いてください。`;
    if (auth.scopeRoots) {
      instructions += `\nアクセスはアサインされたゴール (id: ${auth.scopeRoots.join(", ")}) とその配下の部分木に限定されています。範囲外のゴールは見えず、作成・移動も範囲内のみ可能です。メンバー管理・招待は使えません。この範囲の中で上記の基本ループを全力で回してください。`;
    }
  }
  return instructions;
}

// Instructions reach clients only at initialize, so a claude.ai conversation
// that outlives an edit to INSTRUCTIONS would keep running on stale rules until
// the user manually reconnects the connector. We edit these rules often, so
// re-delivery has to be automatic.
//
// It used to be keyed on an in-memory Set ("deliver once per worker isolate").
// That was wrong: isolates are recycled constantly, not only on deploy, so the
// Set reset all the time and the block ended up appended to nearly every tool
// result — pure noise in the caller's context.
//
// Now it is keyed on a content hash of the instructions, persisted in D1. Each
// (workspace, actor) gets the block exactly once per version of the text: edit
// the rules, and every live connection picks them up on its next tool call;
// leave them alone, and nothing is ever appended.
export const instructionsVersion = (text: string): string => {
  // FNV-1a — we only need "did the text change", not cryptographic strength.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

export const instructionsActorKey = (auth: McpAuth) => auth.actor?.userId ?? "ws-key";

/** Created lazily so a deploy needs no separate migration step. */
export let deliveryTableReady = false;
export async function ensureDeliveryTable(env: Env): Promise<void> {
  if (deliveryTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_instruction_delivery (
       ws_id TEXT NOT NULL,
       actor_key TEXT NOT NULL,
       version TEXT NOT NULL,
       delivered_at TEXT NOT NULL,
       PRIMARY KEY (ws_id, actor_key)
     )`,
  ).run();
  deliveryTableReady = true;
}

export async function markInstructionsDelivered(env: Env, auth: McpAuth, version: string): Promise<void> {
  await ensureDeliveryTable(env);
  await env.DB.prepare(
    `INSERT INTO mcp_instruction_delivery (ws_id, actor_key, version, delivered_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (ws_id, actor_key) DO UPDATE SET version = ?3, delivered_at = ?4`,
  ).bind(auth.wsId, instructionsActorKey(auth), version, new Date().toISOString()).run();
}

/** True when this caller has not yet seen the current text. */
export async function instructionsAreStale(env: Env, auth: McpAuth, version: string): Promise<boolean> {
  await ensureDeliveryTable(env);
  const row = await env.DB.prepare(
    "SELECT version FROM mcp_instruction_delivery WHERE ws_id = ? AND actor_key = ?",
  ).bind(auth.wsId, instructionsActorKey(auth)).first<{ version: string }>();
  return row?.version !== version;
}
