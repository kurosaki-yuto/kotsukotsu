// こつこつシリーズ の構成と、アドレスの導き方。
//
// 中身は 各製品の public/series-nav.js と同じもの。片方だけ直すと食い違うので、
// 製品を足す・サブドメインを変えるときは両方を直す。
//
// ホスト名をどこにも書き込まない。いま開いているホストから、シリーズ全体の
// アドレスを導く。だから独自ドメインへ移した瞬間に、リンクも共通ログインの
// 宛先もそのまま新しいアドレスへ入れ替わる。

export type SeriesProduct = {
  key: string;    // 製品名 (シリーズ共通の呼び名)
  sub: string;    // 独自ドメインでのサブドメイン。本体は空
  wdev: string;   // 中身が動いている Worker の名前 (workers.dev 名)
  pages: string;  // Pages のプロジェクト名。いまの公開アドレスはこれ
  mark: string;   // 列に出す1文字
  short: string;  // 列に出す短い名前
  what: string;   // 持ち場
};

export const PRODUCTS: SeriesProduct[] = [
  { key: "こつこつ",       sub: "",           wdev: "kotsukotsu", pages: "kotsukotsu-app",            mark: "こ", short: "こつこつ", what: "ゴール起点のToDo・実行管理" },
  { key: "こつこつ営業",   sub: "sales",      wdev: "apo-board", pages: "apo-board",             mark: "営", short: "営業",     what: "アポ・受注・着金・行動量の予実" },
  { key: "こつこつマーケ", sub: "marketing",  wdev: "kotsukotsu-marketing", pages: "kotsukotsu-marketing",  mark: "マ", short: "マーケ",   what: "広告・LP・問い合わせの動線" },
  { key: "こつこつ会計",   sub: "accounting", wdev: "kotsukotsu-accounting", pages: "kotsukotsu-accounting", mark: "会", short: "会計",     what: "請求書・レシートの取込と会計連携" },
  { key: "こつこつ契約",   sub: "contracts",  wdev: "kotsukotsu-contracts", pages: "kotsukotsu-contracts",  mark: "契", short: "契約",     what: "契約の締結状況と期限" },
];

export const WORKERS_DEV = "YOUR_SUBDOMAIN.workers.dev";

type Base = { mode: "pages" } | { mode: "workers" } | { mode: "custom"; apex: string };

/** いまのホスト (本体) から、シリーズ全体のアドレスの作り方を決める。 */
export function seriesBase(host: string): Base {
  // いまの公開アドレス。製品ごとに Pages のプロジェクトが1つずつ立っている。
  if (host.endsWith(".pages.dev")) return { mode: "pages" };
  if (host.endsWith(".workers.dev")) return { mode: "workers" };
  // 本体は頂点に置く。www だけ落とす。
  return { mode: "custom", apex: host.replace(/^www\./, "") };
}

/** ある製品の公開URL (末尾スラッシュなし)。 */
export function originOf(p: SeriesProduct, base: Base): string {
  if (base.mode === "pages") return `https://${p.pages}.pages.dev`;
  if (base.mode === "workers") return `https://${p.wdev}.${WORKERS_DEV}`;
  return `https://${p.sub ? p.sub + "." : ""}${base.apex}`;
}

/** シリーズ5製品の公開URL。共通ログインで行き先として認めてよい相手でもある。 */
export function seriesOrigins(host: string): string[] {
  const base = seriesBase(host);
  return PRODUCTS.map((p) => originOf(p, base));
}

/** 本体以外の4製品。列に並べる用。 */
export function otherProducts(host: string): { p: SeriesProduct; origin: string }[] {
  const base = seriesBase(host);
  return PRODUCTS.filter((p) => p.sub !== "").map((p) => ({ p, origin: originOf(p, base) }));
}

/** 製品名から探す。共通ログインの切符の発行元を確かめるのに使う。 */
export function productByKey(key: string): SeriesProduct | undefined {
  return PRODUCTS.find((p) => p.key === key);
}
