import { json, bad } from "../../../lib/server/db";
import { findUserByEmail, createPasswordReset, recentResetCount } from "../../../lib/server/auth";
import { mailConfigured, sendMail, passwordResetMail } from "../../../lib/server/email";
import { publicOrigin } from "@/app/lib/server/platform";

// Ask for a reset link. Anyone can call this without being signed in, which is
// the whole point — the person calling it has lost their way in.
//
// Two things are deliberate here:
//
//  * The response is the same whether or not the address has an account. An
//    endpoint that answers "no such user" is a free membership check for anyone
//    who wants to know who works here.
//  * Mail not being configured is NOT reported as success. That is the one case
//    where the caller genuinely will never receive anything, and telling them
//    "check your inbox" would strand them (AGENTS.md #1 — a failure must not
//    look like a normal empty outcome).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const email = (body.email ?? "").trim();
  if (!email) return bad("email required", 400);

  if (!mailConfigured()) return bad("mail not configured", 503);

  const user = await findUserByEmail(email);
  if (user) {
    // Rate limit per account, not per address, so probing unknown addresses
    // cannot be distinguished from the real thing by timing out differently.
    if ((await recentResetCount(user.id)) < 5) {
      const origin = publicOrigin(req);
      const { token } = await createPasswordReset(
        user.id,
        req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")
      );
      const mail = passwordResetMail(`${origin}/reset/${token}`, user.name);
      const sent = await sendMail({ to: user.email, ...mail });
      // A provider-side failure is real breakage: surface it rather than let
      // the person sit and wait for mail that was never accepted.
      if (!sent.ok) return bad("mail send failed", 502);
    }
  }

  return json({ ok: true });
}
