import { json, bad, uid } from "../../lib/server/db";
import { requireWorkspace, requireGoalEdit } from "../../lib/server/workspace";
import { createResource } from "../../lib/server/queries";
import { bucket, safeName } from "../../lib/server/files";
import { safeContentType, fileResponseHeaders, parseRange } from "../../lib/server/filesCore";
import { targetOfKey, canReadTarget } from "../../lib/server/fileAccess";
import { limitOr429, HOUR } from "../../lib/server/ratelimit";

const MAX_BYTES = 25 * 1024 * 1024; // 25MB per file

function decodeHeader(v: string | null): string {
  if (!v) return "";
  try { return decodeURIComponent(v); } catch { return v; }
}

// Upload a file into R2 and create a "file" resource pointing at it.
// Body = raw file bytes; metadata in headers (x-goal-id, x-filename, content-type).
export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const b = bucket();
  if (!b) return bad("storage unavailable", 500);

  const goalId = req.headers.get("x-goal-id") || "";
  const rawName = (decodeHeader(req.headers.get("x-filename")) || "file").slice(0, 200);
  const caption = decodeHeader(req.headers.get("x-caption")).trim().slice(0, 2000) || null;
  // 送られてきた種類はそのまま信用しない。画像・PDF 以外は octet-stream で保存し、配信時に保存させる (保存型 XSS 対策)
  const contentType = safeContentType(req.headers.get("content-type"));
  if (!goalId) return bad("x-goal-id required", 400);
  const denied = await requireGoalEdit(ctx, goalId); if (denied) return denied;
  const limited = await limitOr429(`files:user:${ctx.user.id}`, 100, HOUR);
  if (limited) return limited;

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return bad("empty file", 400);
  if (buf.byteLength > MAX_BYTES) return bad("ファイルが大きすぎます (25MBまで)", 413);

  const key = `${ctx.workspaceId}/${goalId}/${uid()}-${safeName(rawName)}`;
  await b.put(key, buf, { httpMetadata: { contentType } });
  const r = await createResource(goalId, rawName, ctx.workspaceId, "file", caption, `r2:${key}`);
  return json(r);
}

// Stream a stored file back (authorized: the key must live in the caller's
// workspace and within their goal scope, or be a 型 file of this workspace).
// Range に対応する (動画を途中から再生・シークできるように)。
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return bad("key required", 400);
  const target = targetOfKey(ctx.workspaceId, key);
  if (!target || !(await canReadTarget(ctx, target))) return json({ error: "not found" }, { status: 404 });

  const b = bucket();
  if (!b) return bad("storage unavailable", 500);
  const parts = key.split("/");
  const filename = parts[parts.length - 1].replace(/^[0-9a-f-]{36}-/, "") || "file";
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const head = await b.head(key);
    if (!head) return json({ error: "not found" }, { status: 404 });
    const range = parseRange(rangeHeader, head.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
    if (range) {
      const obj = await b.get(key, { range });
      if (!obj) return json({ error: "not found" }, { status: 404 });
      return new Response((obj as R2ObjectBody).body, {
        status: 206,
        headers: fileResponseHeaders(head.httpMetadata?.contentType || "", filename, {
          "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
          "content-length": String(range.length),
          "accept-ranges": "bytes",
        }),
      });
    }
  }
  const obj = await b.get(key);
  if (!obj) return json({ error: "not found" }, { status: 404 });
  // 保存時の種類を信用せず、配信時にもう一度許可リストを通す (古いファイルにも効く)
  return new Response(obj.body, {
    headers: fileResponseHeaders(obj.httpMetadata?.contentType || "", filename, { "accept-ranges": "bytes", "content-length": String(obj.size) }),
  });
}
