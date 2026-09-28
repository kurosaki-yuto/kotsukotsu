import "server-only";
import { platformEnv } from "@/app/lib/server/platform";
import { json } from "../../../lib/server/db";
import { sendPushToWorkspace, sendPushToMembers, type PushPayload } from "../../../lib/server/push";
import { goalNotificationRecipientEmails } from "../../../lib/server/queries";

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Lets the (separately-deployed) MCP worker trigger a real phone push for a
// workspace after an AI-driven mutation — the MCP worker has no VAPID keys of
// its own and shares nothing with this app except D1, so it calls back here
// instead of duplicating the push-signing logic.
export async function POST(req: Request) {
  const env = platformEnv() as unknown as { PUSH_SECRET?: string };
  const secret = env.PUSH_SECRET;
  if (!secret) return json({ error: "not configured" }, { status: 501 });
  const presented = req.headers.get("x-push-secret") ?? "";
  if (!safeEqual(presented, secret)) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: string; goalId?: string | null; emails?: string[] | null;
    payload?: { title?: string; body?: string | null; url?: string | null } | null;
  };
  if (!body.workspaceId) return json({ error: "workspaceId required" }, { status: 400 });
  const emails = Array.isArray(body.emails) ? body.emails.filter((e): e is string => typeof e === "string" && !!e.trim()) : [];
  // Optional lock-screen payload forwarded from the MCP worker (it knows what
  // the notification says; we just encrypt and deliver it).
  const payload: PushPayload | null = body.payload?.title
    ? { title: body.payload.title, body: body.payload.body ?? null, url: body.payload.url ?? null }
    : null;
  if (emails.length) {
    // explicit target list (@mentions) — can include members not assigned to any goal
    await sendPushToMembers(body.workspaceId, emails, payload);
  } else if (body.goalId) {
    const recipients = await goalNotificationRecipientEmails(body.goalId, body.workspaceId);
    await sendPushToMembers(body.workspaceId, recipients, payload);
  } else {
    await sendPushToWorkspace(body.workspaceId, payload);
  }
  return json({ ok: true });
}
