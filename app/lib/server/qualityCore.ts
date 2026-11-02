// 完了の基準・現状の門 (黒崎判断 2026-11-02)。mcp-worker から使う。
//
// 必ず「目標 → 完了の基準 → 現状 → その差がタスク」になるようにする:
// - AI が書く完了の基準・現状は、甘ければ受け付けずに理由を返す (MCP だけ。画面の手入力は止めない)
// - タスクを足すときは、親の完了の基準のどの行を埋めるタスクか (closes) を持たせる
// - タスクを終えるときは、親の現状も同じ呼び出しで書き直させる (タスクが動いたのに現状が古いまま、を作らない)
// - 既にある完了の基準・現状を update_goal で書き換えるときは、保存せずに変更前後を返し、
//   AI が本人に会話で「これでいいですか」と聞いて confirmed: true で呼び直したときだけ保存する (確認の画面は作らない)

// 意味のある数: 単位つきの数・日付・時刻・コミットのような英数字。行頭の「1.」「【1】」「1-1」「Q1」のような番号の数字は数えない
// (番号の書き方を一つずつ外す作りは、照合で2回すり抜けを見つけられたのでやめた)
const QUANTITY = /(\d+(?:[.,]\d+)?\s*(?:件|円|%|枚|本|社|人|通|回|日|か月|ヶ月|カ月|月|年|週|時間|時|分|秒|行|ページ|頁|章|か所|ヶ所|箇所|名|個|台|万|千|億|点|項目|ケース|文字|字|倍|割|位|号|部|冊|席|組|株|期|kb|KB|mb|MB|gb|GB|px|ms)|20\d\d[-/年.]\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b)/;
const NAMES = "[A-Za-z0-9-]+\\.[a-z]{2,}\\b|\\b[A-Z]{3,}\\b|\\b[a-z]+_[a-z_]+\\b|\\b[a-z]+[A-Z]\\w*\\b|\\x60|https?:\\/\\/|「|『";
// 成果物・数・日付・場所など、○×を付けられる手がかり
const CONCRETE = new RegExp(`(${QUANTITY.source}|${NAMES}|\\.(md|pdf|csv|xlsx?|docx?|pptx?|png|jpe?g|json|ts|tsx|py|html)\\b|画面|シート|ファイル|フォルダ|一覧|表|PDF|URL|スレッド|チャット|コメント|現状|リポジトリ|コミット|本番|テーブル|台帳|メール|返信|スクショ|画像|資料|提案書|見積|請求|契約|入金|承認|OK|公開|送付|送信|登録|記録|デプロイ|PASS)`);
// 「検討する」で終わる行は、残りに意味のある数・ファイル・URL・「」・英数字の名前のどれかが無く短ければ曖昧とみなす
// (「資料を検討する」「契約について確認する」は、名詞が入っていても終わったか判定できない)
const STRONG = new RegExp(`(${QUANTITY.source}|${NAMES})`);
// それだけでは終わったか判定できない言い方 (文の終わり)
const VAGUE_END = /(検討|改善|整理|整備|調整|対応|確認|把握|推進|共有|強化|最適化|見直し|ブラッシュアップ|いい感じに|整える|磨く|よくする|良くする|高める|考える|詰める|固める|深める|検証)(する|します|を行う|を進める|を図る)?[。.]?$/;
const VAGUE_STATE = /^(対応中|進行中|作業中|進めている|進めています|順調|未着手|検討中|確認中)[。.]?$/;
const DATE = /(20\d\d-\d{1,2}-\d{1,2}|20\d\d\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日)/;

const CRITERIA_EXAMPLE = "例: 「提案書PDFを 顧客フォルダ/提案/ に置き、先方へ送付したメールの日付を現状に書いた」「本番 kotukotu.app の型一覧で機能ごとの見出しが出るスクショがある」";
const STATE_EXAMPLE = "例: 「2026-11-02時点。提案書の下書きを作りチャットに貼った (3枚)。\\nボール: 黒崎 (文面のOK待ち、11/2に依頼)。\\n残り: 先方への送付」";

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    // 行頭の記号と番号 (1. / 1) / (1) / （1） / ① など) は中身ではないので外す。外さないと番号の数字で「数字あり」になって素通りする
    .map((l) =>
      l
        .replace(/^[\s□■・\-*●○◯✓✔①-⑳]+/, "")
        // 全角の数字・記号を半角にそろえてから (「１．」も「1.」として外す)
        .normalize("NFKC")
        // 「1.」「1)」「1:」「1 」「#1」「1.1」「(1)」。数字の直後に区切りが無いもの (「3社」「10月分」) は中身なので外さない
        .replace(/^((?:#|No\.?\s?|Step\s?|STEP\s?|step\s?|項目|その)?\d{1,3}(?:\.\d{1,3})*(?:[.)、:]\s*|\s+)|\(\d{1,3}\)\s*)/, "")
        .trim()
    )
    .filter((l) => l && !/^この状態になったら完了。?$/.test(l));
}

/** 完了の基準が甘ければ、AI に返す日本語の理由。通るなら null。 */
export function criteriaProblem(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return `完了の基準が空です。「何が満たされたら完了か」を、他人が○×を付けられる形で書いてください。${CRITERIA_EXAMPLE}`;
  const ls = lines(t);
  if (!ls.length) return `完了の基準に中身がありません。${CRITERIA_EXAMPLE}`;
  // 手がかりの語が無くても、「〜検討する」で終わらず状態を25字以上で書いている行 (「人物を個別に保存・編集でき、適用しても会話ルールを変えない」など) は通す
  const weak = ls.filter((l) => !CONCRETE.test(l) && (l.length < 25 || VAGUE_END.test(l)));
  if (weak.length === ls.length) {
    return `完了の基準に数字・日付・成果物名 (ファイル名・URL・画面名・シート名など) がありません。終わったかどうかを他人が判定できる形にしてください。直す行: ${weak.slice(0, 3).map((l) => `「${l.slice(0, 40)}」`).join(" ")}。${CRITERIA_EXAMPLE}`;
  }
  // 「〜が表示され、行の高さが変わらないことを確認」のように、確かめる中身が書いてある長い行は通す (15字以上)
  const vague = ls.filter((l) => { if (!VAGUE_END.test(l)) return false; const rest = l.replace(VAGUE_END, ""); return !STRONG.test(rest) && rest.length < 15; });
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

// ---------- 「これでいいですか」(会話で聞く) ----------
export const CONFIRM_NOTE =
  "まだ保存していない。needs_confirmation の変更前 (before) と変更後 (after) を本人に見せて、" +
  "「完了の基準・現状をこう変えます。これでいいですか」と聞く。はいなら同じ内容に confirmed: true を付けて update_goal を呼び直す。" +
  "いいえなら言われたとおりに直して、もう一度 confirmed なしで出す。本人がいない (定期実行など) ときは保存せず、send_chat で変更前と変更後を残して止まる";
