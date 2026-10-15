// 添付ファイルと画像の「種類」の扱い。Web (app/api/files, avatar) と mcp-worker (upload_file) で共有する純粋な関数。
//
// 送られてきた content-type をそのまま保存して返すと、text/html や script 入り SVG を上げた人が
// 本体と同じオリジンでスクリプトを動かせる (保存型 XSS)。そのため:
// - そのまま返してよい種類 (画像・PDF) だけ許可リストにし、それ以外は application/octet-stream にする
// - 返すときは Content-Disposition と sandbox の CSP を必ず付ける

// 動画・音声もブラウザ内で再生してよい (スクリプトを含まない形式だけ。配信時は sandbox の CSP も付く)
export const INLINE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm",
]);

// ---------- 大きいファイル ----------
// Worker は 1 リクエストの本文に上限があり、メモリも 128MB なので、大きいファイルは分割して R2 の
// マルチパートアップロードで受ける。R2 は最後以外の分割を同じ大きさ (5MB 以上) にする決まりがある。
export const UPLOAD_PART_BYTES = 10 * 1024 * 1024; // 1 回に送る大きさ (10MB)
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 1 ファイルの上限 (2GB)

export function uploadPartCount(size: number): number {
  return Math.max(1, Math.ceil(size / UPLOAD_PART_BYTES));
}

/**
 * Range ヘッダー (bytes=開始-終了 / bytes=開始- / bytes=-末尾から) を解釈する。動画を途中から再生するため。
 * 1 区間だけ受ける。無い・解釈できない → null (全体を返す)。範囲外 → "unsatisfiable" (416)。
 */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!suffix) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}
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
