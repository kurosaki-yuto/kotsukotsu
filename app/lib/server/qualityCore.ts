// 完了の基準・現状の門と「これでいい？」の確認 (黒崎判断 2026-11-02)。Web と mcp-worker の両方から使う。
//
// 必ず「目標 → 完了の基準 → 現状 → その差がタスク」になるようにする:
// - AI が書く完了の基準・現状は、甘ければ受け付けずに理由を返す (MCP だけ。画面の手入力は止めない)
// - タスクを足すときは、親の完了の基準のどの行を埋めるタスクか (closes) を持たせる
// - タスクを終えるときは、親の現状も同じ呼び出しで書き直させる (タスクが動いたのに現状が古いまま、を作らない)
// - AI が書き換えた完了の基準・現状は、書かせた本人に「これでいい？ はい / いいえ」を一度出す
//   (既にある完了の基準の書き換えは「はい」まで反映しない。現状と新しく書いた基準はすぐ反映し、「いいえ」で戻す)

// 成果物・数字・日付・場所など、○×を付けられる手がかり
const CONCRETE = /([A-Za-z0-9-]+\.[a-z]{2,}\b|\b[A-Z]{3,}\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w*\b|`|\d|[０-９]|https?:\/\/|\.(md|pdf|csv|xlsx?|docx?|pptx?|png|jpe?g|json|ts|tsx|py|html)\b|「|『|画面|シート|ファイル|フォルダ|一覧|表|PDF|URL|スレッド|チャット|コメント|現状|件|円|%|％|枚|本|社|人|通|回|ページ|リポジトリ|コミット|本番|テーブル|台帳|メール|返信|スクショ|画像|資料|提案書|見積|請求|契約|入金|承認|OK|ＯＫ|公開|送付|送信|登録|記録|デプロイ|PASS)/;
// それだけでは終わったか判定できない言い方 (文の終わり)
const VAGUE_END = /(検討|改善|整理|整備|調整|対応|確認|把握|推進|共有|強化|最適化|見直し|ブラッシュアップ|いい感じに|整える|磨く|よくする|良くする|高める)(する|します|を行う|を進める|を図る)?[。.]?$/;
const VAGUE_STATE = /^(対応中|進行中|作業中|進めている|進めています|順調|未着手|検討中|確認中)[。.]?$/;
const DATE = /(20\d\d-\d{1,2}-\d{1,2}|20\d\d\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)/;

const CRITERIA_EXAMPLE = "例: 「提案書PDFを 顧客フォルダ/提案/ に置き、先方へ送付したメールの日付を現状に書いた」「本番 kotukotu.app の型一覧で機能ごとの見出しが出るスクショがある」";
const STATE_EXAMPLE = "例: 「2026-11-02時点。提案書の下書きを作りチャットに貼った (3枚)。\\nボール: 黒崎 (文面のOK待ち、11/2に依頼)。\\n残り: 先方への送付」";

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s□■・\-*●○◯✓✔]+/, "").trim())
    .filter((l) => l && !/^この状態になったら完了。?$/.test(l));
}

/** 完了の基準が甘ければ、AI に返す日本語の理由。通るなら null。 */
export function criteriaProblem(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return `完了の基準が空です。「何が満たされたら完了か」を、他人が○×を付けられる形で書いてください。${CRITERIA_EXAMPLE}`;
  const ls = lines(t);
  if (!ls.length) return `完了の基準に中身がありません。${CRITERIA_EXAMPLE}`;
  const weak = ls.filter((l) => !CONCRETE.test(l));
  if (weak.length === ls.length) {
    return `完了の基準に数字・日付・成果物名 (ファイル名・URL・画面名・シート名など) がありません。終わったかどうかを他人が判定できる形にしてください。直す行: ${weak.slice(0, 3).map((l) => `「${l.slice(0, 40)}」`).join(" ")}。${CRITERIA_EXAMPLE}`;
  }
  const vague = ls.filter((l) => VAGUE_END.test(l) && !CONCRETE.test(l.replace(VAGUE_END, "")));
  if (vague.length) {
    return `完了の基準が「検討する」「対応する」「確認する」のような、終わったか判定できない言い方で終わっています: ${vague.slice(0, 3).map((l) => `「${l.slice(0, 40)}」`).join(" ")}。何ができた状態か (何がどこにあるか・何件か・誰のOKが出たか) で書いてください。${CRITERIA_EXAMPLE}`;
  }
  return null;
}

/** 現状が甘ければ、AI に返す日本語の理由。通るなら null。 */
export function stateProblem(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return `現状が空です。(1) 何日時点か (2) 済んだこと (3) ボール: 次に動く人 (4) 残り・詰まり を書いてください。${STATE_EXAMPLE}`;
  if (VAGUE_STATE.test(t.replace(/\s+/g, ""))) return `現状が「${t.slice(0, 20)}」だけで、何が済んで次に誰が何をするか分かりません。${STATE_EXAMPLE}`;
  const missing: string[] = [];
  if (!DATE.test(t)) missing.push("何日時点か (例: 2026-11-02時点)");
  if (!/ボール/.test(t)) missing.push("「ボール: こちら / 先方 / ◯◯さん / なし」の行 (次に動く人)");
  if (missing.length) return `現状に ${missing.join(" と ")} がありません。${STATE_EXAMPLE}`;
  return null;
}

/** タスク完了のときの結果 (そのタスクの現状) が甘ければ理由。通るなら null。 */
export function resultProblem(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null; // 省略は可 (親の現状のほうで書かせる)
  if (t.length < 12 || /^(完了|済み|対応済み|done|ok)[。.!！]?$/i.test(t)) {
    return "完了の結果が短すぎます。何をして、何が確認できたか (成果物の場所・数字)、未確認は何かを1〜3行で書いてください。";
  }
  return null;
}

/**
 * 親の完了の基準から、closes (このタスクが埋める行) に当たる行を探す。見つかればその行、無ければ null。
 * 行番号 (1 始まり) でも、行の文の一部でも受ける。
 */
export function matchCriteriaLine(parentCriteria: string | null | undefined, closes: string): string | null {
  const ls = lines(parentCriteria ?? "");
  if (!ls.length) return null;
  const c = closes.trim();
  const n = /^#?(\d{1,2})$/.exec(c);
  if (n) return ls[Number(n[1]) - 1] ?? null;
  const norm = (s: string) => s.replace(/[\s「」『』()（）、。,.:：]/g, "");
  const cn = norm(c.replace(/^[□■・\-*]+/, ""));
  if (cn.length < 4) return null;
  return ls.find((l) => { const ln = norm(l); return ln.includes(cn) || (cn.includes(ln) && ln.length >= 4); }) ?? null;
}

export function numberedCriteria(parentCriteria: string | null | undefined): string {
  return lines(parentCriteria ?? "").map((l, i) => `${i + 1}. ${l}`).join("\n");
}

// ---------- 「これでいい？」の確認 ----------
export type ConfirmField = "completion_criteria" | "current_state";
export type GoalConfirmation = {
  id: string; workspace_id: string; goal_id: string; field: ConfirmField;
  before_text: string | null; after_text: string; reason: string | null;
  /** 1 = もう反映した (いいえで戻す) / 0 = はいで反映する */
  applied: number;
  status: "pending" | "accepted" | "rejected" | "superseded";
  requested_by: string | null; requested_by_name: string | null; created_at: string;
  decided_at: string | null; decided_by_name: string | null;
};

/**
 * 確認を 1 件積む。同じゴール・同じ欄でまだ答えていない確認は「新しいものに置き換え」(superseded) にする
 * (現状は何度も書き換わるので、最新の 1 件にだけ答えればよい)。
 */
export async function requestConfirmation(
  db: D1Database,
  o: { wsId: string; goalId: string; field: ConfirmField; before: string | null; after: string; applied: boolean; reason?: string | null; userId: string | null; userName: string | null; now: string }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("UPDATE goal_confirmations SET status = 'superseded', decided_at = ? WHERE workspace_id = ? AND goal_id = ? AND field = ? AND status = 'pending'")
      .bind(o.now, o.wsId, o.goalId, o.field),
    db.prepare(
      `INSERT INTO goal_confirmations (id, workspace_id, goal_id, field, before_text, after_text, reason, applied, status, requested_by, requested_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).bind(id, o.wsId, o.goalId, o.field, o.before, o.after, o.reason?.slice(0, 1000) ?? null, o.applied ? 1 : 0, o.userId, o.userName, o.now),
  ]);
  return id;
}

export const CONFIRM_NOTE_PENDING =
  "完了の基準の書き換えは、まだ反映していない。依頼した本人の画面に「これでいい？ はい / いいえ」が出ていて、はいで反映される。" +
  "本人と会話しているなら、変更前と変更後を並べて「完了の基準をこう変えます。これでいいですか」と一度聞く。いいえなら直して出し直す。";
export const CONFIRM_NOTE_APPLIED =
  "反映した。依頼した本人の画面に「これでいい？ はい / いいえ」が出ていて、いいえなら元に戻り、書き直しを頼むコメントが付く。";
