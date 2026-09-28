"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getOrgSettings,
  updateOrgSettings,
  getApiKey,
  regenApiKey,
  getMyApiKey,
  regenMyApiKey,
  getMe,
  listInvites,
  createInvite,
  revokeInvite,
  getMyProfile,
  updateMyAvatar,
  changeMyPassword,
  getAccountPlan,
  deleteMyAccount,
  type AccountPlan,
  type Me,
  type Invite,
  type MyProfile,
} from "../lib/addness";
import type { OrgSettings } from "../lib/db";
import { MCP_HOST, NODE_RUNTIME } from "../lib/hosts";

type Tab = "team" | "api";

const TABS: { key: Tab; label: string }[] = [
  { key: "team", label: "チーム設定" },
  { key: "api", label: "APIキー" },
];

const FALLBACK_ORG: OrgSettings = {
  id: 1,
  name: "マイワークスペース",
  timezone: "Asia/Tokyo",
  logo_url: null,
  updated_at: "",
};

function formatExpiry(iso: string | null): string {
  if (!iso) return "無期限";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日まで`;
}

/* Resize an image File to a centered square <= MAX×MAX and return a compact JPEG data URL. */
const LOGO_MAX = 256;
async function fileToResizedDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      el.src = objectUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) throw new Error("画像サイズを取得できません");

    // cover/center-crop to a square source region, preserving aspect ratio
    const side = Math.min(srcW, srcH);
    const sx = (srcW - side) / 2;
    const sy = (srcH - side) / 2;

    // output dimension capped at LOGO_MAX (never upscale beyond source side)
    const out = Math.min(LOGO_MAX, side);

    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas を初期化できません");
    ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);

    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* ---------- small inline glyphs ---------- */
function GlyphLink() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l2.43-2.43a5 5 0 0 0-7.07-7.07L11 5" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.5 13.43a5 5 0 0 0 7.07 7.07L13 19" />
    </svg>
  );
}
export default function SettingsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("team");

  const [org, setOrg] = useState<OrgSettings>(FALLBACK_ORG);
  const [name, setName] = useState(FALLBACK_ORG.name);
  const [saving, setSaving] = useState(false);

  const [invites, setInvites] = useState<Invite[]>([]);

  const [apiKey, setApiKey] = useState<string | null>(null);

  const [me, setMe] = useState<Me | null>(null);
  const admin = me?.role === "admin";

  const [profile, setProfile] = useState<MyProfile | null>(null);

  // load current user's own profile (any user, not admin-gated)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await getMyProfile();
        if (alive) setProfile(p);
      } catch {
        /* tolerate; profile card shows placeholder */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // load org + members + me
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { user } = await getMe();
        if (alive) setMe(user);
      } catch {
        /* tolerate; treat as non-admin */
      }
      try {
        const o = await getOrgSettings();
        if (!alive) return;
        setOrg(o);
        setName(o.name);
      } catch {
        /* keep fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // load api key (APIキー tab): admins see the workspace-wide key, everyone
  // else gets their own member key (scoped to their assignment server-side)
  useEffect(() => {
    if (!me) return;
    let alive = true;
    (async () => {
      try {
        const k = admin ? await getApiKey() : await getMyApiKey();
        if (alive) setApiKey(k);
      } catch {
        /* tolerate failure; tab shows unavailable state */
      }
    })();
    return () => {
      alive = false;
    };
  }, [admin, me]);

  // load invites (admin only)
  useEffect(() => {
    if (!admin) {
      setInvites([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const list = await listInvites();
        if (alive) setInvites(list);
      } catch {
        if (alive) setInvites([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [admin]);

  async function reloadInvites(): Promise<void> {
    try {
      setInvites(await listInvites());
    } catch {
      /* tolerate; keep current list */
    }
  }

  async function handleRegenApiKey(): Promise<void> {
    try {
      const k = admin ? await regenApiKey() : await regenMyApiKey();
      setApiKey(k);
    } catch {
      /* ignore network error */
    }
  }

  const dirty = name !== org.name;

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await updateOrgSettings({ name });
      setOrg((prev) => ({ ...prev, name }));
    } catch {
      /* swallow; org local state already optimistic enough */
      setOrg((prev) => ({ ...prev, name }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--app-bg)" }}>
      <div className="mx-auto w-full max-w-[1200px] px-4 py-7 pb-24 md:px-6 md:pb-8">
        {/* ---------- current role pill ---------- */}
        <div className="mb-3">
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-semibold"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          >
            あなた: {admin ? "管理者" : "メンバー"}
          </span>
        </div>

        {/* ---------- top segmented tabs ---------- */}
        <div className="tab-seg tab-seg-lg mb-6 w-full">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? "active" : ""}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "team" && (
          <TeamSettings
            org={org}
            name={name}
            setName={setName}
            dirty={dirty}
            saving={saving}
            onSave={handleSave}
            invites={invites}
            onReloadInvites={reloadInvites}
            admin={admin}
            profile={profile}
            setProfile={setProfile}
          />
        )}
        {tab === "team" && (
          <div className="mx-auto mt-5 w-full max-w-[680px]">
            <DeleteAccountCard />
          </div>
        )}
        {tab === "api" && <ApiKeyTab token={apiKey} onRegen={handleRegenApiKey} admin={admin} />}
      </div>

      {/* segmented control: large variant for the page-level tab bar */}
      <style jsx>{`
        .tab-seg-lg {
          width: 100%;
          display: flex;
          gap: 0;
          padding: 4px;
        }
        .tab-seg-lg button {
          flex: 1 1 0;
          padding: 10px 16px;
          font-size: 14px;
          text-align: center;
        }
      `}</style>
    </div>
  );
}

/* =========================================================
   パスワード変更（自分のログイン情報）
   ========================================================= */
const PASSWORD_MIN = 8;

function PasswordCard() {
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
function DeleteAccountCard() {
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

function PasswordField(props: {
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

function translatePasswordError(msg?: string): string {
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

/* =========================================================
   チーム設定
   ========================================================= */
function TeamSettings(props: {
  org: OrgSettings;
  name: string;
  setName: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  invites: Invite[];
  onReloadInvites: () => Promise<void>;
  admin: boolean;
  profile: MyProfile | null;
  setProfile: React.Dispatch<React.SetStateAction<MyProfile | null>>;
}) {
  const {
    org, name, setName, dirty, saving, onSave,
    invites, onReloadInvites, admin,
    profile, setProfile,
  } = props;

  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  async function handleAvatarSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      setProfile((prev) => (prev ? { ...prev, avatar: dataUrl } : prev));
      await updateMyAvatar(dataUrl);
    } catch {
      /* tolerate read/resize/network failure; UI keeps previous avatar */
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleAvatarRemove() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      setProfile((prev) => (prev ? { ...prev, avatar: null } : prev));
      await updateMyAvatar(null);
    } catch {
      /* tolerate network failure */
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5">
        {/* profile card (current user's own avatar) */}
        <section className="card p-4 md:p-6">
          <h2 className="mb-5 text-base font-bold">プロフィール</h2>
          <div className="flex items-center gap-4">
            <div
              className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full text-[22px] font-bold"
              style={{ background: "#eceef0", color: "var(--muted)" }}
            >
              {profile?.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profile.avatar}
                  alt={`${profile.name}のアイコン`}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <span>{(profile?.name ?? "").slice(0, 1)}</span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="truncate text-[15px] font-semibold" style={{ color: "var(--foreground)" }}>
                {profile?.name ?? "—"}
              </div>
              <div className="flex items-center gap-3">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarSelect}
                />
                <button
                  className="chip"
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarBusy}
                  style={avatarBusy ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                >
                  {avatarBusy ? "更新中…" : "画像を変更"}
                </button>
                {profile?.avatar && (
                  <button
                    type="button"
                    className="text-[13px] font-semibold"
                    style={{ color: "var(--danger)", ...(avatarBusy ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
                    onClick={handleAvatarRemove}
                    disabled={avatarBusy}
                  >
                    削除
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* password card (own credentials) */}
        <PasswordCard />

        {/* org settings card */}
        <section className="card p-4 md:p-6">
          <div className="mb-5 flex items-center gap-2">
            <h2 className="text-base font-bold">{org.name}の組織設定</h2>
            {!admin && (
              <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                編集は管理者のみ
              </span>
            )}
          </div>

          {/* name */}
          <label className="mb-1.5 block text-[13px] font-semibold" style={{ color: "var(--foreground-soft)" }}>
            組織の名前
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!admin}
            className="mb-6 w-full rounded-[10px] border bg-transparent px-3.5 py-2.5 text-[15px] outline-none focus:border-[var(--accent)]"
            style={{ borderColor: "var(--border)", color: "var(--foreground)", ...(!admin ? { opacity: 0.6, cursor: "not-allowed" } : null) }}
          />

          {admin && (
            <button
              type="button"
              className="btn-dark"
              onClick={onSave}
              disabled={!dirty || saving}
              style={!dirty || saving ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          )}
        </section>

        {/* invite management card */}
        <section className="card p-4 md:p-6">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-base font-bold">招待管理</h2>
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            >
              Beta
            </span>
          </div>

          {!admin ? (
            <p className="py-4 text-[13px]" style={{ color: "var(--muted)" }}>
              招待の作成・管理は管理者のみです。
            </p>
          ) : (
            <InviteLinkTab invites={invites} onReloadInvites={onReloadInvites} />
          )}
        </section>
    </div>
  );
}

/* =========================================================
   招待: 共有リンクのコピーボックス
   ========================================================= */
function CopyBox({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function handleCopy() {
    try {
      navigator.clipboard?.writeText(url);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-[10px] border px-3.5 py-2.5"
      style={{ borderColor: "var(--border)", background: "#fafafb" }}
    >
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 truncate bg-transparent font-mono text-[13px] outline-none"
        style={{ color: "var(--foreground)" }}
      />
      <button type="button" className="chip flex-none" onClick={handleCopy}>
        {copied ? "コピー済" : "コピー"}
      </button>
    </div>
  );
}

/* =========================================================
   招待リンク タブ
   ========================================================= */
function InviteLinkTab({
  invites,
  onReloadInvites,
}: {
  invites: Invite[];
  onReloadInvites: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const { url } = await createInvite(undefined, "member");
      if (url) setNewUrl(url);
      await onReloadInvites();
    } catch {
      /* tolerate network error */
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(token: string) {
    try {
      await revokeInvite(token);
    } catch {
      /* ignore */
    }
    await onReloadInvites();
  }

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        className="btn-dark self-start"
        onClick={handleCreate}
        disabled={creating}
        style={creating ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
      >
        {creating ? "作成中…" : "招待リンクを作成"}
      </button>

      {newUrl && <CopyBox url={newUrl} />}

      {invites.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="mb-3" style={{ color: "var(--muted-soft)" }}>
            <GlyphLink />
          </div>
          <div className="text-[14px]" style={{ color: "var(--muted)" }}>
            有効な招待リンクはありません
          </div>
        </div>
      ) : (
        <ul className="flex flex-col">
          {invites.map((inv) => (
            <li
              key={inv.token}
              className="flex items-center justify-between gap-3 py-3"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px]">
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                  >
                    {inv.role === "admin" ? "管理者" : "メンバー"}
                  </span>
                  {inv.email && (
                    <span className="truncate" style={{ color: "var(--foreground-soft)" }}>
                      {inv.email}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                  {formatExpiry(inv.expires_at)}
                </div>
              </div>
              <button
                type="button"
                className="flex-none text-[13px] font-semibold"
                style={{ color: "var(--danger)" }}
                onClick={() => void handleRevoke(inv.token)}
              >
                取り消し
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* =========================================================
   APIキー
   ========================================================= */
const MCP_WORKERS_DEV = `https://${MCP_HOST}/mcp`;

// キー入りURLの接続先。独自ドメインから開いていれば mcp.kotukotu.app、pages.dev の入口から
// 開いていれば同じアドレスの /mcp を渡す (Pages が service binding で kotsukotsu-mcp へ渡す)。
// それ以外は workers.dev 直。
function mcpEndpoint(): string {
  if (typeof window === "undefined") return MCP_WORKERS_DEV;
  const { host, origin } = window.location;
  if (NODE_RUNTIME) return `${origin}/mcp`; // Docker 版は同じサーバーが /mcp を受ける
  if (host === "kotukotu.app" || host.endsWith(".kotukotu.app")) return MCP_SHARED;
  return host.endsWith(".pages.dev") ? `${origin}/mcp` : MCP_WORKERS_DEV;
}

// 全員共通の接続先。キーは入っていない。claude.ai / Claude Code はここに繋ぐと
// (独自ドメインにしているのは、claude.ai のコネクタ一覧のアイコンを こつこつ にするため。
//  pages.dev のままだと Cloudflare のロゴになる。pages-proxy/public/_worker.js 参照)
// サインイン (OAuth) に進み、こつこつにログインしている本人として繋がる
// (mcp-worker/src/oauth.ts)。SaaS のコネクタと同じく、URL は全員同じでよい。
const MCP_SHARED = "https://mcp.kotukotu.app/mcp";

// キー無しの共通URL (OAuth でログイン) が使えるのは kotukotu.app だけ。自分でデプロイした
// こつこつ (workers.dev) は本体と MCP が別ホストでログイン cookie が届かないので、
// キー入りURLを案内する。
function sharedLoginAvailable(): boolean {
  if (typeof window === "undefined") return true;
  const { host } = window.location;
  return host === "kotukotu.app" || host.endsWith(".kotukotu.app");
}

// A labeled, copyable code/config block (used by the per-client connect guides).
function Snippet({ label, code, note }: { label: string; code: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  function copy() {
    try { navigator.clipboard?.writeText(code); } catch { /* clipboard unavailable */ }
    setCopied(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="rounded-[10px] border p-3" style={{ borderColor: "var(--border)", background: "#fff" }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-bold" style={{ color: "var(--foreground)" }}>{label}</span>
        <button type="button" className="chip flex-none" onClick={copy}>{copied ? "コピー済" : "コピー"}</button>
      </div>
      <pre className="overflow-x-auto rounded-[8px] px-3 py-2.5 font-mono text-[12px] leading-relaxed" style={{ background: "#0f1420", color: "#e6e9ef", whiteSpace: "pre" }}>{code}</pre>
      {note && <div className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{note}</div>}
    </div>
  );
}

function ApiKeyTab({ token, onRegen, admin }: { token: string | null; onRegen: () => Promise<void>; admin: boolean }) {
  const [urlCopied, setUrlCopied] = useState(false);
  const [sharedCopied, setSharedCopied] = useState(false);
  const [sharedLogin, setSharedLogin] = useState(true);
  useEffect(() => setSharedLogin(sharedLoginAvailable()), []);
  const sharedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (urlTimer.current) clearTimeout(urlTimer.current);
      if (sharedTimer.current) clearTimeout(sharedTimer.current);
    };
  }, []);

  const hasToken = typeof token === "string" && token.length > 0;

  // 接続用フルURL（キーをクエリパラメータとして含む）。これ1本を貼るだけで接続できる。
  // トークンはパス埋め込み (claude.ai のカスタムコネクタはクエリ文字列を
  // 落とすことがあるため)。旧 ?key= 形式も引き続き有効。
  const connectUrl = hasToken ? `${mcpEndpoint()}/${token!}` : "";
  // 見出しの「接続用URL」。自分でデプロイした環境ではキー入りURLになる。
  const headlineUrl = sharedLogin ? MCP_SHARED : connectUrl;

  function handleCopyUrl() {
    if (!hasToken) return;
    try {
      navigator.clipboard?.writeText(connectUrl);
    } catch {
      /* clipboard unavailable */
    }
    setUrlCopied(true);
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => setUrlCopied(false), 1500);
  }

  function handleCopyShared() {
    try {
      if (!headlineUrl) return;
      navigator.clipboard?.writeText(headlineUrl);
    } catch {
      /* clipboard unavailable */
    }
    setSharedCopied(true);
    if (sharedTimer.current) clearTimeout(sharedTimer.current);
    sharedTimer.current = setTimeout(() => setSharedCopied(false), 1500);
  }

  async function handleRegen() {
    if (!window.confirm("再生成すると今のキー入りURLは無効になります。続行?")) return;
    await onRegen();
  }

  return (
    <section className="card max-w-[680px] p-4 md:p-6">
      <h2 className="mb-1.5 text-base font-bold">AIと繋ぐ（MCP）</h2>
      <p className="mb-6 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Claudeを繋ぐと、AIがあなたのゴールやタスクを直接読み書きできるようになります。
        繋がるのはログインしたあなた本人として、あなたが見られる範囲だけです。
      </p>

      {/* ---------- explainer video: watch before following the steps below ---------- */}
      <div className="mb-6 rounded-[12px] border overflow-hidden" style={{ borderColor: "var(--border)" }}>
        <div className="px-5 pt-4 pb-3 text-[14px] font-bold" style={{ color: "var(--foreground)" }}>
          使い方動画（AI接続）
        </div>
        <div style={{ position: "relative", paddingBottom: "56.25%", height: 0 }}>
          <iframe
            src="https://www.loom.com/embed/9589122229694a0db9c4f40acc4ad86e"
            title="こつこつ AI接続の使い方"
            allow="fullscreen"
            allowFullScreen
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }}
          />
        </div>
      </div>

      {/* ---------- headline: shared connect URL (sign in with your own account) ---------- */}
      <div
        className="mb-6 rounded-[12px] border p-5"
        style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}
      >
        <div className="mb-1.5 text-[14px] font-bold" style={{ color: "var(--foreground)" }}>
          {sharedLogin ? "接続用URL（全員共通）" : "接続用URL（あなた専用）"}
        </div>
        <div className="mb-3.5 text-[12px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
          {sharedLogin
            ? "キーは入っていません。誰が使っても同じURLで、繋ぐときにこつこつのログインで本人を確認します。"
            : "あなたのキーが入っています。人に共有しないでください。漏れたら下の「再生成」で無効化できます。"}
        </div>

        <div
          className="mb-3 flex items-center gap-2 rounded-[10px] border px-3.5 py-2.5"
          style={{ borderColor: "var(--border)", background: "#fff" }}
        >
          <input
            readOnly
            value={headlineUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 truncate bg-transparent font-mono text-[13px] outline-none"
            style={{ color: "var(--foreground)" }}
          />
        </div>

        <button type="button" className="btn-dark w-full" onClick={handleCopyShared}>
          {sharedCopied ? "コピー済" : "コピー"}
        </button>

        <ol className="mt-4 flex flex-col gap-2">
          {[
            <>① 上の「接続用URL」をコピー</>,
            <>
              ② Claudeの<strong>「カスタムコネクタを追加」</strong>を開き、
              名前に <strong>kotsukotsu</strong>（半角英数）、
              <strong>「リモートMCPサーバーURL」</strong>にペーストして<strong>「追加」</strong>
              （OAuth欄は空のままでOK）
            </>,
            sharedLogin ? (
              <>
                ③ <strong>「連携させる」</strong>を押すと、こつこつのログイン画面が開きます。
                ログインすれば接続完了（すでにログイン中なら自動で完了）
              </>
            ) : (
              <>③ <strong>「連携させる」</strong>を押せば接続完了</>
            ),
          ].map((body, i) => (
            <li
              key={i}
              className="text-[13px] leading-relaxed"
              style={{ color: "var(--foreground-soft)" }}
            >
              {body}
            </li>
          ))}
        </ol>

        <div className="mt-3.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          名前を日本語にするとツールが見つからなくなる環境があるため、半角英数を推奨します。
        </div>
      </div>

      {/* ---------- per-client connect guides (Codex / Claude Code / others) ---------- */}
      {hasToken && (
        <div className="mb-6 rounded-[12px] border p-5" style={{ borderColor: "var(--border)", background: "#fafafb" }}>
          <div className="mb-1.5 text-[14px] font-bold" style={{ color: "var(--foreground)" }}>
            他のAIツールと繋ぐ（Claude Code / Codex など）
          </div>
          <div className="mb-4 text-[12px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
            {sharedLogin
              ? "Claude Code は共通URLのまま、初回にブラウザでログインするだけで繋がります。ログイン画面を出せないツール（Codex など）は、あなた専用のキー入りURLを使います。"
              : "どのツールも、あなた専用のキー入りURLで繋ぎます。"}
          </div>
          <div className="flex flex-col gap-3">
            <Snippet
              label="Claude Code（ターミナル）"
              code={`claude mcp add --transport http kotsukotsu ${headlineUrl}`}
              note={sharedLogin
                ? "実行後、Claude Code で /mcp → kotsukotsu → Authenticate を選ぶとブラウザでログイン画面が開きます。"
                : "キー入りURLなので、実行すればそのまま繋がります。コマンドは人に共有しないでください。"}
            />
            <Snippet
              label="あなた専用のキー入りURL（ログイン画面を出せないツール用）"
              code={connectUrl}
              note="このURLにはキーが含まれます。人に共有しないでください。"
            />
            <Snippet
              label="Codex CLI（~/.codex/config.toml に追記）"
              code={`[mcp_servers.kotsukotsu]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${connectUrl}"]`}
              note="保存後 codex を再起動。npx が mcp-remote を自動取得し、リモートMCPに橋渡しします。"
            />
            <Snippet
              label="その他（Cursor / Windsurf / 汎用 stdio クライアント）"
              code={`npx -y mcp-remote "${connectUrl}"`}
              note="各ツールのMCP設定で、この1行を command として登録。HTTPのリモートMCPをstdioに変換します。"
            />
          </div>
          <div className="mt-3.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            キー入りURLとそれを使うコマンドは共有しないでください。漏れたら下の「再生成」で一括無効化できます。
          </div>
        </div>
      )}

      {/* ---------- regenerate (invalidates the connect URL) ---------- */}
      <div className="mb-6">
        <button type="button" className="chip" onClick={handleRegen}>
          キー入りURLを再生成（無効化）
        </button>
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          再生成すると今のキー入りURLは無効になります。共通URLで繋いでいる場合も、Claude側で再接続が必要になることがあります。
        </div>
      </div>

      {/* ---------- capabilities ---------- */}
      <div
        className="rounded-[10px] border p-4"
        style={{ borderColor: "var(--border)", background: "#fafafb" }}
      >
        <div className="mb-2.5 text-[13px] font-bold" style={{ color: "var(--foreground)" }}>
          MCPで操作できること
        </div>
        <ul className="flex flex-col gap-1.5">
          {[
            "ゴール／タスクの一覧・作成・更新・完了",
            "担当者のアサイン（割り当て）",
            "コメントの追加",
            "通知の作成",
          ].map((cap) => (
            <li
              key={cap}
              className="flex items-start gap-2 text-[13px] leading-relaxed"
              style={{ color: "var(--foreground-soft)" }}
            >
              <span className="flex-none pt-0.5" style={{ color: "var(--accent)" }}>
                •
              </span>
              <span>{cap}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
