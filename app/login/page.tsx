"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { validateInvite, acceptInviteAsUser } from "../lib/addness";

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

type Mode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);

  // forgot-password flow
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);

  // invite (read from ?invite= without useSearchParams to avoid prerender issues)
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<string | null>(null);
  const [inviteEmailLocked, setInviteEmailLocked] = useState(false);
  const [inviteInvalid, setInviteInvalid] = useState(false);
  const [inviteReason, setInviteReason] = useState<string | null>(null);
  const [signedInNoJoin, setSignedInNoJoin] = useState(false);

  // ?signup=1 — サービスページの「はじめる」から来た人は新規登録の画面で開く。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("signup") === "1") setMode("register");
  }, []);

  // On mount: read an invite token from the URL and validate it.
  useEffect(() => {
    let alive = true;
    const token = new URLSearchParams(window.location.search).get("invite");
    if (!token) return;
    setInviteToken(token);
    (async () => {
      try {
        const res = await validateInvite(token);
        if (!alive) return;
        if (res.valid) {
          setMode("register");
          setInviteRole(res.role ?? "member");
          if (res.email) {
            setEmail(res.email);
            setInviteEmailLocked(true);
          }
        } else {
          setInviteInvalid(true);
          setInviteReason(res.reason ?? null);
        }
      } catch {
        if (alive) setInviteInvalid(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // On mount: if already signed in, accept a pending invite (join + switch
  // workspace) before bouncing to home. Otherwise pick the initial tab based
  // on whether the instance still needs its first account.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        if (!alive) return;
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as
            | { user?: unknown; needsBootstrap?: boolean }
            | null;
          if (data?.user) {
            const token = new URLSearchParams(window.location.search).get("invite");
            if (token) {
              try {
                await acceptInviteAsUser(token);
              } catch {
                // stale invite + not a member: stay here and explain instead
                // of silently landing the user in their own workspace
                if (alive) {
                  setInviteInvalid(true);
                  setSignedInNoJoin(true);
                }
                return;
              }
            }
            if (goNext()) return;
            router.replace("/");
            return;
          }
          if (data?.needsBootstrap) setMode("register");
        }
      } catch {
        /* offline / env not set — show the form anyway */
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (mode === "register" && !name.trim()) {
      setError("名前を入力してください。");
      return;
    }
    setSubmitting(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload: Record<string, string> = {
        email: email.trim(),
        password,
      };
      if (mode === "register") payload.name = name.trim();
      // both paths honor the invite: register joins on signup, login joins on sign-in
      if (inviteToken && !inviteInvalid) payload.invite = inviteToken;

      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        if (goNext()) return;
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

  // Request a reset link. Success here only means the request was accepted —
  // the reply is intentionally identical whether or not the address has an
  // account, so the wording never confirms who has one.
  async function onForgot(e: React.FormEvent) {
    e.preventDefault();
    if (forgotBusy) return;
    setError(null);
    if (!email.trim()) {
      setError("メールアドレスを入力してください。");
      return;
    }
    setForgotBusy(true);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.ok) {
        setForgotSent(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(translateError(data?.error) ?? "うまくいきませんでした。もう一度お試しください。");
    } catch {
      setError("通信に失敗しました。接続を確認してください。");
    } finally {
      setForgotBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  function openForgot() {
    setForgot(true);
    setForgotSent(false);
    setError(null);
  }
  function closeForgot() {
    setForgot(false);
    setForgotSent(false);
    setError(null);
  }

  return (
    <div
      className="flex min-h-screen w-full items-center justify-center px-4 py-10"
      style={{ background: "var(--app-bg)" }}
    >
      <div className="card w-full max-w-[400px] px-8 py-9" style={{ boxShadow: "var(--shadow-pop)" }}>
        {/* brand */}
        <div className="flex flex-col items-center text-center">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-2xl text-white"
            style={{ background: "var(--accent)" }}
          >
            {feather}
          </span>
          <h1 className="mt-4 text-[26px] font-bold tracking-tight" style={{ color: "var(--foreground)" }}>
            こつこつ
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
            コツれば終わる
          </p>
        </div>

        {/* invite banner */}
        {inviteToken && !inviteInvalid && inviteRole && (
          <div
            className="mt-6 rounded-xl px-4 py-3 text-[13px] font-medium"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            role="status"
          >
            ワークスペースに招待されています（役割: {inviteRole === "admin" ? "管理者" : "メンバー"}）
            <span className="mt-1 block text-[12px] font-normal">
              {mode === "register"
                ? "アカウントを作成すると参加できます。既にアカウントをお持ちの方はログインでも参加できます。"
                : "ログインすると招待先のワークスペースに参加します。"}
            </span>
          </div>
        )}
        {inviteInvalid && (
          <div
            className="mt-6 rounded-xl px-4 py-3 text-center text-[12px]"
            style={{ background: "var(--hover)", color: "var(--muted)" }}
            role="status"
          >
            {inviteReason === "expired"
              ? "この招待リンクは期限切れです。招待した人に新しいリンクの発行を依頼してください。"
              : "招待リンクが無効です。URLが正しいかご確認ください。"}
            {signedInNoJoin && (
              <button
                type="button"
                onClick={() => router.replace("/")}
                className="mt-2 block w-full font-semibold underline-offset-2 hover:underline"
                style={{ color: "var(--accent)" }}
              >
                ホームへ戻る
              </button>
            )}
          </div>
        )}

        {forgot ? (
          forgotSent ? (
            <div className="mt-7 flex flex-col gap-4">
              <div
                className="rounded-xl px-4 py-3 text-[13px]"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                role="status"
              >
                再設定用のメールをお送りしました。
                <span className="mt-1 block text-[12px] font-normal">
                  {email.trim()} 宛の受信箱をご確認ください。リンクは1時間で切れます。
                  届かない場合は迷惑メールもご確認ください。
                </span>
              </div>
              <button
                type="button"
                onClick={closeForgot}
                className="btn-dark w-full justify-center py-2.5 text-[14px] font-semibold"
                style={{ background: "var(--accent)" }}
              >
                ログイン画面へ戻る
              </button>
            </div>
          ) : (
            <form onSubmit={onForgot} className="mt-7 flex flex-col gap-4">
              <p className="text-[13px]" style={{ color: "var(--muted)" }}>
                登録しているメールアドレスを入力してください。パスワードを再設定するリンクをお送りします。
              </p>

              <Field label="メールアドレス">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="login-input"
                />
              </Field>

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
                disabled={forgotBusy}
                className="btn-dark mt-1 w-full justify-center py-2.5 text-[14px] font-semibold disabled:opacity-60"
                style={{ background: "var(--accent)" }}
              >
                {forgotBusy ? "送信中…" : "再設定リンクを送る"}
              </button>

              <button
                type="button"
                onClick={closeForgot}
                className="text-center text-[13px] font-semibold underline-offset-2 hover:underline"
                style={{ color: "var(--muted)" }}
              >
                ログイン画面へ戻る
              </button>
            </form>
          )
        ) : (
          <>
        {/* tabs */}
        <div
          className="mt-7 grid grid-cols-2 gap-1 rounded-xl p-1"
          style={{ background: "var(--hover)" }}
          role="tablist"
        >
          {(["login", "register"] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchMode(m)}
                className="rounded-lg py-2 text-[13px] font-semibold transition-colors"
                style={{
                  background: active ? "var(--surface)" : "transparent",
                  color: active ? "var(--foreground)" : "var(--muted)",
                  boxShadow: active ? "var(--shadow-card)" : "none",
                }}
              >
                {m === "login" ? "ログイン" : "新規登録"}
              </button>
            );
          })}
        </div>

        {/* form */}
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          {mode === "register" && (
            <Field label="名前">
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="山田 太郎"
                autoComplete="name"
                className="login-input"
              />
            </Field>
          )}

          <Field label="メールアドレス">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="login-input"
              readOnly={mode === "register" && inviteEmailLocked}
              style={mode === "register" && inviteEmailLocked ? { opacity: 0.7, cursor: "not-allowed" } : undefined}
            />
          </Field>

          <Field label="パスワード">
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="login-input"
            />
          </Field>

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
            disabled={submitting || checking || (mode === "register" && !name.trim())}
            className="btn-dark mt-1 w-full justify-center py-2.5 text-[14px] font-semibold disabled:opacity-60"
            style={{ background: "var(--accent)" }}
          >
            {submitting ? "処理中…" : mode === "login" ? "ログイン" : "新規登録"}
          </button>

          {mode === "login" && (
            <button
              type="button"
              onClick={openForgot}
              className="text-center text-[13px] font-semibold underline-offset-2 hover:underline"
              style={{ color: "var(--muted)" }}
            >
              パスワードをお忘れですか？
            </button>
          )}
        </form>

        {/* footer toggle */}
        <p className="mt-5 text-center text-[13px]" style={{ color: "var(--muted)" }}>
          {mode === "login" ? (
            <>
              アカウントをお持ちでない方は{" "}
              <button
                type="button"
                onClick={() => switchMode("register")}
                className="font-semibold underline-offset-2 hover:underline"
                style={{ color: "var(--accent)" }}
              >
                新規登録
              </button>
            </>
          ) : (
            <>
              すでにアカウントをお持ちの方は{" "}
              <button
                type="button"
                onClick={() => switchMode("login")}
                className="font-semibold underline-offset-2 hover:underline"
                style={{ color: "var(--accent)" }}
              >
                ログイン
              </button>
            </>
          )}
        </p>
          </>
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

// ?next=/authorize?... — Claude のコネクタ接続 (mcp-worker の OAuth) がログインを挟んだ時の戻り先。
// /authorize は Next のページではなく Worker が受けるので、router ではなく素の遷移で戻す。
// 外部サイトへ飛ばされないよう、自分のところの絶対パスだけ通す。
function goNext(): boolean {
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  if (!next.startsWith("/") || next.startsWith("//")) return false;
  window.location.replace(next);
  return true;
}

function translateError(msg?: string): string | null {
  if (!msg) return null;
  switch (msg) {
    case "invalid credentials":
      return "メールアドレスまたはパスワードが正しくありません。";
    case "email and password required":
      return "メールアドレスとパスワードを入力してください。";
    case "email taken":
      return "このメールアドレスは既に登録されています。";
    case "email required":
      return "メールアドレスを入力してください。";
    // Mail is not wired up on this environment yet — say so plainly instead of
    // claiming a mail was sent that will never arrive.
    case "mail not configured":
      return "このこつこつはメールを送らない設定です。管理者に「パスワード再設定リンク」を発行してもらってください（管理者のメンバー画面から発行できます）。";
    case "mail send failed":
      return "メールの送信に失敗しました。時間をおいて再度お試しください。";
    default:
      return msg;
  }
}
