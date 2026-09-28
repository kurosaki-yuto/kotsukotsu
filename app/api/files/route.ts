import { json, bad, uid } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { createResource } from "../../lib/server/queries";
import { bucket, safeName } from "../../lib/server/files";

const MAX_BYTES = 25 * 1024 * 1024; // 25MB per file

// Upload a file into R2 and create a "file" resource pointing at it.
// Body = raw file bytes; metadata in headers (x-goal-id, x-filename, content-type).
export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const b = bucket();
  if (!b) return bad("storage unavailable", 500);

  const goalId = req.headers.get("x-goal-id") || "";
  const rawName = decodeURIComponent(req.headers.get("x-filename") || "file");
  const captionHeader = req.headers.get("x-caption");
  const caption = captionHeader ? decodeURIComponent(captionHeader).trim() || null : null;
  const contentType = req.headers.get("content-type") || "application/octet-stream";
  if (!goalId) return bad("x-goal-id required", 400);
  if (!(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return bad("empty file", 400);
  if (buf.byteLength > MAX_BYTES) return bad("ファイルが大きすぎます (25MBまで)", 413);

  const key = `${ctx.workspaceId}/${goalId}/${uid()}-${safeName(rawName)}`;
  await b.put(key, buf, { httpMetadata: { contentType } });
  const r = await createResource(goalId, rawName, ctx.workspaceId, "file", caption, `r2:${key}`);
  return json(r);
}

// Stream a stored file back (authorized: the key must live in the caller's
// workspace and within their goal scope).
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return bad("key required", 400);
  // key = <wsId>/<goalId>/<file>
  const parts = key.split("/");
  if (parts[0] !== ctx.workspaceId) return json({ error: "not found" }, { status: 404 });
  const goalId = parts[1];
  if (goalId && !(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });

  const b = bucket();
  if (!b) return bad("storage unavailable", 500);
  const obj = await b.get(key);
  if (!obj) return json({ error: "not found" }, { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}
