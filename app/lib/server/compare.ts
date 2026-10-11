// 秘密 (トークン・署名) の比較。長さや一致位置で処理時間が変わらないようにする。
// Web (app/) と Worker (mcp-worker / realtime-worker) で共有する純粋な関数。server-only は import しない。
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
