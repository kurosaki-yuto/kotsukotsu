"use client";

// 設定 > チーム設定 の下に出す、自分のアカウントのカード (パスワード変更・退会)。settings/page.tsx から切り出し。
import type * as React from "react";
import { useState } from "react";
import { changeMyPassword, getAccountPlan, deleteMyAccount, type AccountPlan } from "../lib/addness";


/* =========================================================
   パスワード変更（自分のログイン情報）
   ========================================================= */
export const PASSWORD_MIN = 8;

export function PasswordCard() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (next.length < PASSWORD_MIN) {
      setError(`新しいパスワードは${PASSWORD_MIN}文字以上にしてください。`);
      return;
    }
    if (next !== confirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      await changeMyPassword(current, next);
      reset();
      setOpen(false);
      setDone(true);
    } catch (e) {
      setError(translatePasswordError(e instanceof Error ? e.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4 md:p-6">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">パスワード</h2>
        {!open && (
          <button
            type="button"
            className="chip"
            onClick={() => {
              setOpen(true);
              setDone(false);
            }}
          >
            変更する
          </button>
        )}
      </div>
      <p className="text-[13px]" style={{ color: "var(--muted)" }}>
        ログインに使うパスワードを変更します。変更すると、他の端末のログインは解除されます。
      </p>

      {done && (
        <p
          className="mt-4 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          role="status"
        >
          パスワードを変更しました。他の端末は再度ログインが必要です。
        </p>
      )}

      {open && (
        <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4">
          <PasswordField
            label="現在のパスワード"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
          <PasswordField
            label="新しいパスワード"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
          />
          <PasswordField
            label="確認のためもう一度"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
          />

          <p className="text-[12px]" style={{ color: "var(--muted)" }}>
            {PASSWORD_MIN}文字以上。
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

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="btn-dark justify-center px-5 py-2 text-[14px] font-semibold disabled:opacity-60"
              style={{ background: "var(--accent)" }}
            >
              {busy ? "変更中…" : "変更する"}
            </button>
            <button
              type="button"
              className="text-[13px] font-semibold"
              style={{ color: "var(--muted)" }}
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* =========================================================
   退会（アカウント削除）
   ========================================================= */
export function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<AccountPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setOpen(true);
    setError(null);
    setLoadError(null);
    setPlan(null);
    try {
      setPlan(await getAccountPlan());
    } catch {
      setLoadError("退会の内容を読み込めませんでした。時間をおいてもう一度お試しください。");
    }
  }

  function cancel() {
    setOpen(false);
    setPassword("");
    setConfirmText("");
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !plan || plan.blocked.length) return;
    if (confirmText !== "退会する") {
      setError("確認のため「退会する」と入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteMyAccount(password);
      // セッションは消えている。サービスページへ戻す。
      window.location.replace("/");
    } catch (e) {
      const msg = e instanceof Error ? e.message : undefined;
      setError(
        msg === "current password incorrect"
          ? "パスワードが正しくありません。"
          : msg === "blocked"
            ? "管理者があなただけのワークスペースがあります。先に他のメンバーを管理者にしてください。"
            : "退会できませんでした。もう一度お試しください。"
      );
      setBusy(false);
    }
  }

  return (
    <section className="card p-4 md:p-6">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">退会</h2>
        {!open && (
          <button type="button" className="chip" style={{ color: "var(--danger)" }} onClick={begin}>
            退会する
          </button>
        )}
      </div>
      <p className="text-[13px]" style={{ color: "var(--muted)" }}>
        アカウントを削除します。元に戻すことはできません。
      </p>

      {open && (
        <div className="mt-5 flex flex-col gap-4">
          {!plan && !loadError && <p className="text-[13px]" style={{ color: "var(--muted)" }}>読み込み中…</p>}
          {loadError && (
            <p className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "#fdeaea", color: "var(--danger)" }} role="alert">
              {loadError}
            </p>
          )}

          {plan && plan.blocked.length > 0 && (
            <div className="rounded-lg px-3 py-3 text-[13px] leading-relaxed" style={{ background: "#fdeaea", color: "var(--danger)" }} role="alert">
              <p className="font-semibold">まだ退会できません。</p>
              <p className="mt-1">
                次のワークスペースは、管理者があなただけで、他にもメンバーがいます。先にメンバーの誰かを管理者にしてから退会してください。
              </p>
              <ul className="mt-2 list-disc pl-5">
                {plan.blocked.map((w) => <li key={w.id}>{w.name}</li>)}
              </ul>
            </div>
          )}

          {plan && plan.blocked.length === 0 && (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="rounded-lg px-3 py-3 text-[13px] leading-relaxed" style={{ background: "var(--surface-2, #f6f7f9)" }}>
                <p className="font-semibold">退会すると、次のようになります。</p>
                <ul className="mt-2 list-disc pl-5" style={{ color: "var(--foreground-soft)" }}>
                  <li>アカウント（名前・メールアドレス・パスワード）を削除します。</li>
                  {plan.purge.length > 0 && (
                    <li>
                      あなたしかいないワークスペースは、中のゴール・タスク・コメント・ファイルごと削除します：
                      {plan.purge.map((w) => w.name).join("、")}
                    </li>
                  )}
                  {plan.leave.length > 0 && (
                    <li>
                      他のメンバーがいるワークスペースからは抜けます。書いたコメントは「退会したメンバー」として残ります：
                      {plan.leave.map((w) => w.name).join("、")}
                    </li>
                  )}
                  <li>接続していたAI（Claude など）からは、こつこつを使えなくなります。</li>
                </ul>
              </div>

              <PasswordField label="現在のパスワード" value={password} onChange={setPassword} autoComplete="current-password" />
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold" style={{ color: "var(--foreground-soft)" }}>
                  確認のため「退会する」と入力
                </span>
                <input
                  type="text"
                  required
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="退会する"
                  className="w-full rounded-[10px] px-3 py-2.5 text-[14px]"
                  style={{ border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--foreground)" }}
                />
              </label>

              {error && (
                <p className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "#fdeaea", color: "var(--danger)" }} role="alert">
                  {error}
                </p>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy || confirmText !== "退会する" || !password}
                  className="btn-dark justify-center px-5 py-2 text-[14px] font-semibold disabled:opacity-50"
                  style={{ background: "var(--danger)" }}
                >
                  {busy ? "削除中…" : "アカウントを削除する"}
                </button>
                <button type="button" className="text-[13px] font-semibold" style={{ color: "var(--muted)" }} onClick={cancel}>
                  キャンセル
                </button>
              </div>
            </form>
          )}

          {plan && plan.blocked.length > 0 && (
            <div>
              <button type="button" className="text-[13px] font-semibold" style={{ color: "var(--muted)" }} onClick={cancel}>
                閉じる
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function PasswordField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold" style={{ color: "var(--foreground-soft)" }}>
        {props.label}
      </span>
      <input
        type="password"
        required
        minLength={props.minLength}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="••••••••"
        autoComplete={props.autoComplete}
        className="w-full rounded-[10px] px-3 py-2.5 text-[14px]"
        style={{
          border: "1px solid var(--border-strong)",
          background: "var(--surface)",
          color: "var(--foreground)",
        }}
      />
    </label>
  );
}

export function translatePasswordError(msg?: string): string {
  switch (msg) {
    case "current password incorrect":
      return "現在のパスワードが正しくありません。";
    case "current password required":
      return "現在のパスワードを入力してください。";
    case "password too short":
      return `新しいパスワードは${PASSWORD_MIN}文字以上にしてください。`;
    case "password unchanged":
      return "現在のパスワードと同じです。別のパスワードにしてください。";
    case "unauthorized":
      return "セッションが切れています。ログインし直してください。";
    default:
      return msg || "変更できませんでした。もう一度お試しください。";
  }
}
