// 添付ファイルと画像の「種類」の扱い。Web (app/api/files, avatar) と mcp-worker (upload_file) で共有する純粋な関数。
//
// 送られてきた content-type をそのまま保存して返すと、text/html や script 入り SVG を上げた人が
// 本体と同じオリジンでスクリプトを動かせる (保存型 XSS)。そのため:
// - そのまま返してよい種類 (画像・PDF) だけ許可リストにし、それ以外は application/octet-stream にする
// - 返すときは Content-Disposition と sandbox の CSP を必ず付ける

export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
export const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const AVATAR_MAX_CHARS = 200_000; // base64 で約 150KB

/** 保存・配信に使う content-type。許可リスト以外は octet-stream に落とす (SVG・HTML・JS など)。 */
export function safeContentType(declared: string | null | undefined): string {
  const t = (declared ?? "").split(";")[0].trim().toLowerCase();
  return INLINE_TYPES.has(t) ? t : "application/octet-stream";
}

/** ファイル応答のヘッダー。画像と PDF はブラウザ内で開いてよい (inline)、それ以外は保存させる (attachment)。 */
export function fileResponseHeaders(contentType: string, filename: string, extra?: Record<string, string>): Record<string, string> {
  const ct = safeContentType(contentType);
  const disposition = INLINE_TYPES.has(ct) ? "inline" : "attachment";
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 120) || "file";
  return {
    "content-type": ct,
    "content-disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).slice(0, 400)}`,
    "x-content-type-options": "nosniff",
    // 万一スクリプトが混ざっていても、このオリジンの cookie・ストレージ・親ページには触れない
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    "cache-control": "private, max-age=3600",
    ...(extra ?? {}),
  };
}

/** アバターとして保存してよい値か。data:image/(png|jpeg|webp|gif);base64,… だけ。null は「消す」。 */
export function validAvatar(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  if (v.length > AVATAR_MAX_CHARS) return false;
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(v);
  return !!m && AVATAR_TYPES.has(m[1]);
}
