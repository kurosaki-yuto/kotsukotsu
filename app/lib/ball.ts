// 「あなたの番」: 現状 (current_state) の「ボール: ◯◯」の行から、次に動くのが誰かを読む。
// AI は現状を「日付 / 済んだこと / ボール / 残り・詰まり」で書く (MCP の運用ルール)。ボールの行に
// 名前が書かれたタスクが、その人の返事・作業待ち。アプリ (/api/my-turn) と MCP (list_my_turn) で共通。
//
// 2026-10-05 の本番データ: 未完了でボールの行があるタスク 135件、うち黒崎の名前が出るもの 71件。
// 「ボール: 黒崎 (原稿の確認)」のように持ち主として書かれたもの 57件と、
// 「ボール: こちら (黒崎の判断待ち)」のように括弧の中に出るもの 14件。後者も本人の番なので両方拾い、前者を先に並べる。

/** 現状からボールの行 (「ボール:」の後ろ) を取り出す。無ければ null */
export function ballText(state: string | null | undefined): string | null {
  if (!state) return null;
  const m = state.match(/(?:^|\n)[ \t　]*ボール[ \t　]*[:：][ \t　]*(.+)/);
  const text = m?.[1]?.trim();
  return text ? text : null;
}

const strip = (s: string) => s.replace(/[\s　]+/g, "");

/** その人を指す書き方。フルネーム・スペース抜き・姓 (スペース区切りなら前半、無ければ先頭2文字) */
export function personKeys(name: string): string[] {
  const full = name.trim();
  if (!full) return [];
  const keys = new Set<string>([full, strip(full)]);
  const parts = full.split(/[\s　]+/).filter(Boolean);
  if (parts.length > 1) keys.add(parts[0]);
  else if (strip(full).length >= 3) keys.add(strip(full).slice(0, 2));
  return [...keys].filter((k) => k.length >= 2);
}

/**
 * ボールの行がその人を指しているか。
 * 0 = 指していない / 1 = 持ち主として書かれている (「黒崎 (…)」) / 2 = 括弧の中などで出てくる (「こちら (黒崎の判断待ち)」)
 */
export function ballRank(ball: string, keys: string[]): 0 | 1 | 2 {
  if (!keys.length) return 0;
  // 「先方 (…) と小西さん (…)」「こちら(…)、黒崎(…)」のように持ち主が並ぶので、句点・スラッシュに加えて
  // 閉じ括弧の後の「と」「、」でも区切る
  const segs = ball.split(/[。/／]|(?<=[)）])\s*[と、,]\s*/).filter((s) => s.trim());
  let mentioned = false;
  for (const seg of segs) {
    const [owner, ...rest] = seg.split(/[（(]/);
    if (keys.some((k) => owner.includes(k))) return 1;
    // 「先方 (松本さん本人)」の松本は先方の人。持ち主が先方の括弧の中は、こちらのメンバーとして数えない
    if (!owner.includes("先方") && keys.some((k) => rest.join("(").includes(k))) mentioned = true;
  }
  return mentioned ? 2 : 0;
}
