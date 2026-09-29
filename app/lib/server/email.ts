import "server-only";
import { platformEnv } from "@/app/lib/server/platform";

// Outbound mail. On Cloudflare this goes through the Email Service `send_email`
// binding (EMAIL in wrangler.jsonc), so production needs no third-party account.
// Where that binding does not exist (the Docker build) it falls back to Resend's
// REST API — a direct fetch rather than the SDK, since the whole surface we need
// is one POST.
//
// Mail is not configured on every environment (local dev, a fresh preview), and
// a password reset that silently does nothing is exactly the failure mode this
// app keeps hitting. So `sendMail` reports "not configured" as its own outcome
// instead of resolving as if the mail went out — the caller has to decide what
// the person on the other end is told.

export type MailResult =
  | { ok: true }
  | { ok: false; reason: "not-configured" }
  | { ok: false; reason: "send-failed"; message: string };

type EmailBinding = {
  send(message: {
    to: string;
    from: string | { email: string; name?: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId: string }>;
};

type MailEnv = { EMAIL?: EmailBinding; RESEND_API_KEY?: string; MAIL_FROM?: string };

const DEFAULT_FROM = "こつこつ <noreply@mochimotsu.co.jp>";

function mailEnv(): MailEnv {
  const env = platformEnv();
  return (env ?? {}) as MailEnv;
}

export function mailConfigured(): boolean {
  const env = mailEnv();
  return !!env.EMAIL || !!env.RESEND_API_KEY;
}

// "こつこつ <noreply@example.com>" → { name, email }. The binding takes the
// display name as its own field rather than parsing it out of the string.
function parseFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return { email: from.trim() };
  return m[1] ? { email: m[2], name: m[1] } : { email: m[2] };
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<MailResult> {
  const env = mailEnv();

  if (env.EMAIL) {
    try {
      const r = await env.EMAIL.send({
        to: opts.to,
        from: parseFrom(env.MAIL_FROM || DEFAULT_FROM),
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
      console.log("email binding accepted", r?.messageId);
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      console.error("email binding send failed", err.code, err.message);
      return { ok: false, reason: "send-failed", message: err.code || err.message || "email binding error" };
    }
  }

  if (!env.RESEND_API_KEY) return { ok: false, reason: "not-configured" };

  let r: Response;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || DEFAULT_FROM,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }),
    });
  } catch (e) {
    return { ok: false, reason: "send-failed", message: e instanceof Error ? e.message : "network error" };
  }

  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string };
    return { ok: false, reason: "send-failed", message: body.message || `resend ${r.status}` };
  }
  return { ok: true };
}

// ---------- templates ----------

// `byAdmin` は管理者がメンバー画面から発行した場合。本人が頼んだわけではないので、
// 「受け付けました」ではなく管理者が発行したことを書き、有効期限も発行側に合わせる。
//
// 文面は迷惑メール判定を避けるため、なりすましメールの典型から離してある
// (2026-09-29 に Gmail で迷惑メール扱いになった)。色付きの大きなボタンは使わず、
// リンクは表示するURLと飛び先を同じにする。どのアカウント宛てか・どこから頼んだか・
// 運営者を本文に書き、受け取った本人が自分の操作だと分かるようにする。
export function passwordResetMail(
  url: string,
  name: string | null,
  opts: { validFor?: string; byAdmin?: boolean; email?: string } = {}
): { subject: string; text: string; html: string } {
  const greeting = name ? `${name} さん` : "こんにちは";
  const subject = "こつこつ パスワード再設定のリンク";
  const validFor = opts.validFor ?? "1時間";
  const account = opts.email ? `(${opts.email})` : "";
  const lead = opts.byAdmin
    ? `こつこつのワークスペースの管理者が、あなたのアカウント${account}のパスワード再設定リンクを発行しました。`
    : `こつこつのログイン画面で、あなたのアカウント${account}のパスワード再設定が申し込まれました。`;
  const site = new URL(url).origin;
  const text = [
    `${greeting}`,
    "",
    lead,
    "次のURLを開くと、新しいパスワードを決められます。",
    "",
    url,
    "",
    `このURLは${validFor}有効で、1回だけ使えます。`,
    "新しいパスワードを決めると、ほかの端末ではログアウトされます。",
    "",
    "申し込んだ覚えがない場合は、このメールは開かずに削除してください。今のパスワードはそのまま使えます。",
    "",
    "--",
    "こつこつ",
    site,
    "運営: 合同会社もちもつ",
    "このメールは送信専用のアドレスから送っています。",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;font-size:14px;line-height:1.8;color:#22252a">
  <p>${escapeHtml(greeting)}</p>
  <p>${escapeHtml(lead)}<br>次のURLを開くと、新しいパスワードを決められます。</p>
  <p><a href="${escapeHtml(url)}" style="word-break:break-all">${escapeHtml(url)}</a></p>
  <p>このURLは${escapeHtml(validFor)}有効で、1回だけ使えます。<br>
    新しいパスワードを決めると、ほかの端末ではログアウトされます。</p>
  <p>申し込んだ覚えがない場合は、このメールは開かずに削除してください。今のパスワードはそのまま使えます。</p>
  <p style="color:#6b7280">--<br>こつこつ<br>${escapeHtml(site)}<br>運営: 合同会社もちもつ<br>このメールは送信専用のアドレスから送っています。</p>
</div>`;
  return { subject, text, html };
}

export function passwordChangedMail(name: string | null): { subject: string; text: string; html: string } {
  const greeting = name ? `${name} さん` : "こんにちは";
  const subject = "【こつこつ】パスワードが変更されました";
  const text = [
    `${greeting}`,
    "",
    "こつこつのパスワードが変更されました。",
    "他の端末のログインは解除されています。",
    "",
    "心当たりがない場合は、すぐに管理者へ連絡してください。",
    "",
    "— こつこつ",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',sans-serif;font-size:14px;line-height:1.9;color:#22252a">
  <p>${escapeHtml(greeting)}</p>
  <p>こつこつのパスワードが変更されました。他の端末のログインは解除されています。</p>
  <p style="font-size:12px;color:#6b7280">心当たりがない場合は、すぐに管理者へ連絡してください。</p>
  <p style="font-size:12px;color:#9ca3af">— こつこつ</p>
</div>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
