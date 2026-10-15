import { json, bad, uid } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import { createResource } from "../../../lib/server/queries";
import { bucket, safeName } from "../../../lib/server/files";
import { safeContentType, UPLOAD_MAX_BYTES, UPLOAD_PART_BYTES, uploadPartCount } from "../../../lib/server/filesCore";
import { keyPrefix, targetOfKey, denyWrite, type FileTarget } from "../../../lib/server/fileAccess";
import { limitOr429, HOUR } from "../../../lib/server/ratelimit";

// 大きいファイルを分割して R2 に上げる (マルチパートアップロード)。上限 2GB、1 回 10MB。
//   POST {action:"start", goal_id | template_id, filename, size, content_type} → {key, upload_id, part_bytes, parts}
//   PUT  ?key=&upload_id=&part=N  本文 = その分割のバイト列 (最後以外はちょうど part_bytes) → {part, etag}
//   POST {action:"complete", key, upload_id, parts:[{part, etag}], filename, caption?} → ゴールならリソースを作って返す / 型なら {key, size}
//   POST {action:"abort", key, upload_id}
// 毎回キーから行き先 (ゴール / 型) を読み直して書き込み権限を確かめる。

type Body = Record<string, unknown>;
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");

async function targetFor(ctx: NonNullable<Awaited<ReturnType<typeof requireWorkspace>>>, key: string): Promise<{ target: FileTarget } | Response> {
  const target = targetOfKey(ctx.workspaceId, key);
  if (!target) return json({ error: "not found" }, { status: 404 });
  const denied = await denyWrite(ctx, target);
  return denied ?? { target };
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const b = bucket();
  if (!b) return bad("storage unavailable", 500);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") return bad("invalid body", 400);
  const action = str(body.action, 20);

  if (action === "start") {
    const target: FileTarget | null =
      typeof body.goal_id === "string" && body.goal_id ? { kind: "goal", goalId: body.goal_id }
      : typeof body.template_id === "string" && body.template_id ? { kind: "template", templateId: body.template_id }
      : null;
    if (!target) return bad("goal_id か template_id が必要です", 400);
    const denied = await denyWrite(ctx, target);
    if (denied) return denied;
    const limited = await limitOr429(`files:user:${ctx.user.id}`, 100, HOUR);
    if (limited) return limited;
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) return bad("empty file", 400);
    if (size > UPLOAD_MAX_BYTES) return bad("ファイルが大きすぎます (2GBまで)", 413);
    const filename = str(body.filename, 200) || "file";
    const key = `${keyPrefix(ctx.workspaceId, target)}${uid()}-${safeName(filename)}`;
    const upload = await b.createMultipartUpload(key, { httpMetadata: { contentType: safeContentType(str(body.content_type, 100)) } });
    return json({ key, upload_id: upload.uploadId, part_bytes: UPLOAD_PART_BYTES, parts: uploadPartCount(size) });
  }

  const key = str(body.key, 600);
  const uploadId = str(body.upload_id, 600);
  if (!key || !uploadId) return bad("key と upload_id が必要です", 400);
  const t = await targetFor(ctx, key);
  if (t instanceof Response) return t;
  const upload = b.resumeMultipartUpload(key, uploadId);

  if (action === "abort") {
    await upload.abort();
    return json({ ok: true });
  }
  if (action !== "complete") return bad("unknown action", 400);

  const parts = Array.isArray(body.parts) ? body.parts : [];
  const list = parts
    .map((p) => ({ partNumber: Number((p as Body).part), etag: str((p as Body).etag, 200) }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.etag)
    .sort((a, b2) => a.partNumber - b2.partNumber);
  if (!list.length) return bad("parts が空です", 400);
  const obj = await upload.complete(list);
  const filename = str(body.filename, 200) || key.split("/").pop()!.replace(/^[0-9a-f-]{36}-/, "");
  if (t.target.kind === "goal") {
    const caption = str(body.caption, 2000).trim() || null;
    const r = await createResource(t.target.goalId, filename, ctx.workspaceId, "file", caption, `r2:${key}`);
    return json({ ...(r as object), key, size: obj.size });
  }
  return json({ key, size: obj.size, url: `r2:${key}`, name: filename });
}

export async function PUT(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const b = bucket();
  if (!b) return bad("storage unavailable", 500);
  const q = new URL(req.url).searchParams;
  const key = q.get("key") || "";
  const uploadId = q.get("upload_id") || "";
  const part = Number(q.get("part"));
  if (!key || !uploadId || !Number.isInteger(part) || part < 1 || part > uploadPartCount(UPLOAD_MAX_BYTES)) return bad("key / upload_id / part が不正です", 400);
  const t = await targetFor(ctx, key);
  if (t instanceof Response) return t;
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return bad("empty part", 400);
  if (buf.byteLength > UPLOAD_PART_BYTES) return bad("1 回に送れるのは 10MB までです", 413);
  const r = await b.resumeMultipartUpload(key, uploadId).uploadPart(part, buf);
  return json({ part: r.partNumber, etag: r.etag });
}
