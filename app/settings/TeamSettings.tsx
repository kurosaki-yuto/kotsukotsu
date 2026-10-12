"use client";

// 設定 > チーム設定 (プロフィール・組織名・招待管理)。settings/page.tsx から切り出し。
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { createInvite, revokeInvite, updateMyAvatar, type Invite, type MyProfile } from "../lib/addness";
import type { OrgSettings } from "../lib/db";
import { GlyphLink, fileToResizedDataUrl, formatExpiry } from "./page";
import { PasswordCard } from "./AccountCards";


/* =========================================================
   チーム設定
   ========================================================= */
export function TeamSettings(props: {
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
export function CopyBox({ url }: { url: string }) {
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
      {/* 入力欄にすると横に動かさないと全部見えないので、折り返す文字で出す (押すと全選択) */}
      <div className="min-w-0 flex-1 select-all break-all font-mono text-[13px]" style={{ color: "var(--foreground)" }}>
        {url}
      </div>
      <button type="button" className="chip flex-none" onClick={handleCopy}>
        {copied ? "コピー済" : "コピー"}
      </button>
    </div>
  );
}

/* =========================================================
   招待リンク タブ
   ========================================================= */
export function InviteLinkTab({
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
