// 「あなたの番」: 現状 (current_state) の「ボール: ◯◯」の行から、次に動くのが誰かを読む。
// AI は現状を「日付 / 済んだこと / ボール / 残り・詰まり」で書く (MCP の運用ルール)。ボールの行に
// 名前が書かれたタスクが、その人の返事・作業待ち。アプリ (/api/my-turn) と MCP (list_my_turn) で共通。
//
// 2026-10-05 の本番データ: 未完了でボールの行があるタスク 135件。「ボール: 黒崎 (原稿の確認)」のように持ち主として
// 書かれたものと、「ボール: こちら (黒崎の判断待ち)」のように持ち主が「こちら」で括弧の中に出るものの両方を拾い、前者を先に並べる。

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

/** 括弧の外にある区切り (。 / と 、) でだけ切る。括弧の中の「。」で切ると、中の人名を持ち主と取り違える */
function splitOwners(ball: string): { owner: string; inner: string }[] {
  const out: { owner: string; inner: string }[] = [];
  let depth = 0, owner = "", inner = "";
  const flush = () => { if ((owner + inner).trim()) out.push({ owner: owner.trim(), inner }); owner = ""; inner = ""; };
  for (let i = 0; i < ball.length; i++) {
    const ch = ball[i];
    if (ch === "(" || ch === "（") { depth++; if (depth === 1) continue; }
    if (ch === ")" || ch === "）") { depth = Math.max(0, depth - 1); if (depth === 0) continue; }
    if (depth === 0 && /[。/／、,]/.test(ch)) { flush(); continue; }
    // 「先方 (…) と小西さん (…)」: 閉じ括弧の直後の「と」も区切り
    if (depth === 0 && ch === "と" && /[)）]\s*$/.test(ball.slice(0, i))) { flush(); continue; }
    if (depth === 0) owner += ch; else inner += ch;
  }
  flush();
  return out;
}

/**
 * ボールの行がその人を指しているか。
 * 0 = 指していない / 1 = 持ち主として書かれている (「黒崎 (…)」「…は小西さん」)
 * 2 = 持ち主が「こちら」で、括弧の中にその人が出る (「こちら (黒崎の判断待ち)」)
 * 「黒崎 (野田さんへの連絡)」の野田は相手であって持ち主ではない。「先方 (松本さん本人)」の松本は先方の人。どちらも数えない。
 */
export function ballRank(ball: string, keys: string[]): 0 | 1 | 2 {
  if (!keys.length) return 0;
  let mentioned = false;
  for (const { owner, inner } of splitOwners(ball)) {
    if (keys.some((k) => owner.includes(k))) return 1;
    // 「小西さんに渡す」「野田さんへ連絡」のように、渡す・伝える相手として出てくるものは数えない
    if (owner.includes("こちら") && keys.some((k) => new RegExp(`${k}(?:さん|様)?(?!(?:さん|様)?(?:に|へ|から))`).test(inner))) mentioned = true;
  }
  return mentioned ? 2 : 0;
}
