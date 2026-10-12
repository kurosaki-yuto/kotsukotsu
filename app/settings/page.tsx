"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getOrgSettings, updateOrgSettings, getApiKey, regenApiKey, getMyApiKey, regenMyApiKey, getMe, listInvites, getMyProfile, type Me, type Invite, type MyProfile } from "../lib/addness";
import type { OrgSettings } from "../lib/db";
import { DeleteAccountCard } from "./AccountCards";
import { TeamSettings } from "./TeamSettings";
import { ApiKeyTab, GuideTab } from "./ApiKeyTab";

type Tab = "team" | "api" | "guide";

const TABS: { key: Tab; label: string }[] = [
  { key: "team", label: "チーム設定" },
  { key: "api", label: "APIキー" },
  { key: "guide", label: "連携ガイド" },
];

const FALLBACK_ORG: OrgSettings = {
  id: 1,
  name: "マイワークスペース",
  timezone: "Asia/Tokyo",
  logo_url: null,
  updated_at: "",
};

export function formatExpiry(iso: string | null): string {
  if (!iso) return "無期限";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日まで`;
}

/* Resize an image File to a centered square <= MAX×MAX and return a compact JPEG data URL. */
const LOGO_MAX = 256;
export async function fileToResizedDataUrl(file: File): Promise<string> {
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
export function GlyphLink() {
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
        {tab === "guide" && <GuideTab token={apiKey} />}
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
