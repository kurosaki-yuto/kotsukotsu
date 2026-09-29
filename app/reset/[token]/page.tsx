"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const feather = (
  <svg
    width="34"
    height="34"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20 4C11 4 4 11 4 20" />
    <path d="M20 4c0 7-5 13-12 14l-4 0 0-4" />
    <path d="M14 8l-7 7" />
  </svg>
);

const PASSWORD_MIN = 8;

type LinkState =
  | { status: "checking" }
  | { status: "ok"; email: string; name: string | null }
  | { status: "dead"; reason: string };

export default function ResetPasswordPage() {
  const router = useRouter();
  // Read the token from the path rather than route props, matching how the
  // login page reads its invite token — keeps this a plain client page with no
  // prerender surprises.
  const [token, setToken] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>({ status: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).pop() ?? "");
    if (!t) {
      setLink({ status: "dead", reason: "invalid" });
      return;
    }
    setToken(t);
    (async () => {
      try {
        const res = await fetch(`/api/auth/reset?token=${encodeURIComponent(t)}`, {
          credentials: "same-origin",
        });
        const data = (await res.json().catch(() => null)) as
          | { valid?: boolean; reason?: string; email?: string; name?: string | null }
          | null;
        if (!alive) return;
        if (res.ok && data?.valid) {
          setLink({ status: "ok", email: data.email ?? "", name: data.name ?? null });
        } else {
          setLink({ status: "dead", reason: data?.reason ?? "invalid" });
        }
      } catch {
        // Never silently show a working form on a link we could not verify.
        if (alive) setLink({ status: "dead", reason: "network" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !token) return;
    setError(null);
    if (password.length < PASSWORD_MIN) {
      setError(`パスワードは${PASSWORD_MIN}文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        // The server signed us in on this device already.
        router.replace("/");
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(translateError(data?.error) ?? "うまくいきませんでした。もう一度お試しください。");
    } catch {
      setError("通信に失敗しました。接続を確認してください。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="flex min-h-screen w-full items-center justify-center px-4 py-10"
      style={{ background: "var(--app-bg)" }}
    >
      <div className="card w-full max-w-[400px] px-8 py-9" style={{ boxShadow: "var(--shadow-pop)" }}>
        <div className="flex flex-col items-center text-center">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-2xl text-white"
            style={{ background: "var(--accent)" }}
          >
            {feather}
          </span>
          <h1 className="mt-4 text-[26px] font-bold tracking-tight" style={{ color: "var(--foreground)" }}>
            パスワード再設定
          </h1>
          {link.status === "ok" && (
            <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
              {link.email}
            </p>
          )}
        </div>

        {link.status === "checking" && (
          <p className="mt-8 text-center text-[13px]" style={{ color: "var(--muted)" }}>
            リンクを確認しています…
          </p>
        )}

        {link.status === "dead" && (
          <div className="mt-7 flex flex-col gap-4">
            <div
              className="rounded-xl px-4 py-3 text-center text-[13px]"
              style={{ background: "#fdeaea", color: "var(--danger)" }}
              role="alert"
            >
              {deadReason(link.reason)}
            </div>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="btn-dark w-full justify-center py-2.5 text-[14px] font-semibold"
              style={{ background: "var(--accent)" }}
            >
              ログイン画面へ戻る
            </button>
          </div>
        )}

        {link.status === "ok" && (
          <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4">
            <Field label="新しいパスワード">
              <input
                type="password"
                required
                minLength={PASSWORD_MIN}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="login-input"
              />
            </Field>
            <Field label="確認のためもう一度">
              <input
                type="password"
                required
                minLength={PASSWORD_MIN}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className="login-input"
              />
            </Field>

            <p className="text-[12px]" style={{ color: "var(--muted)" }}>
              {PASSWORD_MIN}文字以上。設定すると、他の端末のログインは解除されます。
            </p>

            {error && (
              <p
                className="rounded-lg px-3 py-2 text-[13px]"
                style={{ background: "#fdeaea", color: "var(--danger)" }}
                role="alert"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="btn-dark mt-1 w-full justify-center py-2.5 text-[14px] font-semibold disabled:opacity-60"
              style={{ background: "var(--accent)" }}
            >
              {submitting ? "設定中…" : "パスワードを設定する"}
            </button>
          </form>
        )}
      </div>

      <style jsx global>{`
        .login-input {
          width: 100%;
          border: 1px solid var(--border-strong);
          border-radius: 10px;
          background: var(--surface);
          padding: 10px 12px;
          font-size: 14px;
          color: var(--foreground);
          transition: border-color 0.12s, box-shadow 0.12s;
        }
        .login-input::placeholder {
          color: var(--muted-soft);
        }
        .login-input:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold" style={{ color: "var(--foreground-soft)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function deadReason(reason: string): string {
  switch (reason) {
    case "expired":
      return "このリンクは期限切れです（発行から1時間）。ログイン画面からもう一度お送りください。";
    case "used":
      return "このリンクはもう使えません。パスワードを再設定済みか、管理者が新しいリンクを送っています。いちばん新しいメールのリンクを開くか、ログイン画面からもう一度お送りください。";
    case "network":
      return "リンクの確認に失敗しました。接続を確認して、ページを再読み込みしてください。";
    default:
      return "リンクが無効です。URLが最後まで正しくコピーされているかご確認ください。";
  }
}

function translateError(msg?: string): string | null {
  if (!msg) return null;
  if (msg === "password too short") return `パスワードは${PASSWORD_MIN}文字以上にしてください。`;
  if (msg.startsWith("reset ")) return deadReason(msg.slice("reset ".length));
  return msg;
}
