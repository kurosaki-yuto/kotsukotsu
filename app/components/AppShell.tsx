"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unreadCount, listGoals, getMyProfile, updateMyAvatar, listWorkspaces, createWorkspace, switchWorkspace, createInvite, UNREAD_CHANGED_EVENT, type MyProfile, type Workspace } from "../lib/addness";
import { type Goal } from "../lib/db";
import RealtimeBridge from "./RealtimeBridge";
import LoadFailureBanner from "./LoadFailureBanner";

// Resize an image File to a centered 256x256 square JPEG data URL.
function resizeToSquareDataUrl(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

// ---- icons (line style) ----
const ic = (p: React.ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{p}</svg>
);
const ICON = {
  todo: ic(<><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 12l3 3 5-6" /></>),
  goals: ic(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>),
  bell: ic(<><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  chat: ic(<><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z" /></>),
  members: ic(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3 3 0 0 1 0 5.5M21 20a6 6 0 0 0-4.5-5.8" /></>),
  gear: ic(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17 4.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>),
  feather: ic(<><path d="M20 4C11 4 4 11 4 20" /><path d="M20 4c0 7-5 13-12 14l-4 0 0-4" /><path d="M14 8l-7 7" /></>),
  search: ic(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></>),
};

type NavItem = { key: string; href: string; label: string; icon: React.ReactNode };
const NAV: NavItem[] = [
  { key: "todo", href: "/", label: "タスク", icon: ICON.todo },
  { key: "notifications", href: "/notifications", label: "通知", icon: ICON.bell },
  { key: "members", href: "/members", label: "メンバー", icon: ICON.members },
  { key: "settings", href: "/settings", label: "設定", icon: ICON.gear },
];
// (ゴール/チャットはナビから除外。アイコンは将来用に残置)
void ICON.goals; void ICON.chat;

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const mainRef = useRef<HTMLElement | null>(null);
  // <main> is a shared layout element that persists across route changes —
  // without this, opening a new goal keeps whatever scroll position the
  // previous page was left at instead of starting at the top.
  useEffect(() => { mainRef.current?.scrollTo(0, 0); }, [pathname]);
  const [unread, setUnread] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [q, setQ] = useState("");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  const fileInputRef = useRef<HTMLInputElement>(null);
  // workspaces (logo / top-right switcher)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWsId, setActiveWsId] = useState<string>("");
  const [wsOpenTop, setWsOpenTop] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [creating, setCreating] = useState(false);
  const [wsInviteUrl, setWsInviteUrl] = useState<string | null>(null);
  const [wsInviteBusy, setWsInviteBusy] = useState(false);
  const activeWs = useMemo(() => workspaces.find((w) => w.id === activeWsId), [workspaces, activeWsId]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // load the user's workspaces once authenticated (powers the switcher).
  useEffect(() => {
    if (authed !== true) return;
    let alive = true;
    (async () => {
      try {
        const { workspaces: ws, activeId } = await listWorkspaces();
        if (!alive) return;
        setWorkspaces(ws); setActiveWsId(activeId);
      } catch { /* env not set / not logged in */ }
    })();
    return () => { alive = false; };
  }, [authed]);

  // Switching workspace changes every dataset; do a full reload into the home
  // view so all pages refetch under the new workspace.
  async function onSwitchWs(id: string) {
    if (id === activeWsId) return;
    try { await switchWorkspace(id); } catch { return; }
    window.location.href = "/";
  }
  async function onCreateWs() {
    const name = newWsName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await createWorkspace(name); // server makes it active
      window.location.href = "/";
    } catch {
      setCreating(false);
    }
  }
  // Generate a join link for the CURRENT workspace and copy it. Anyone who
  // registers with the link joins this workspace as a member.
  async function inviteToWorkspace() {
    if (wsInviteBusy) return;
    setWsInviteBusy(true);
    try {
      const { url } = await createInvite(undefined, "member");
      if (url) {
        setWsInviteUrl(url);
        try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
      }
    } catch { /* not admin / network */ }
    finally { setWsInviteBusy(false); }
  }

  // shared switcher dropdown (overlay + card). posClass anchors the card.
  const wsMenu = (onClose: () => void, posClass: string) => (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div role="menu" className={`absolute z-50 w-56 card overflow-hidden py-1 ${posClass}`} style={{ boxShadow: "var(--shadow-pop)" }}>
        <div className="px-3 py-1.5 text-[11px] font-bold text-[var(--muted)]">ワークスペース</div>
        {workspaces.map((w) => (
          <button
            key={w.id}
            type="button"
            role="menuitem"
            onClick={() => { onClose(); onSwitchWs(w.id); }}
            className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm hover:bg-[var(--hover)]"
          >
            <span className="w-5 h-5 rounded-md bg-[#7c93ff] text-white text-[11px] font-bold flex items-center justify-center shrink-0">{w.name[0] ?? "?"}</span>
            <span className="flex-1 truncate">{w.name}</span>
            {w.id === activeWsId && (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7bc47f" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l4 4 10-11" /></svg>
            )}
          </button>
        ))}
        <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
        <button
          type="button"
          role="menuitem"
          onClick={() => { onClose(); setNewWsName(""); setCreateOpen(true); }}
          className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm hover:bg-[var(--hover)]"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          新規ワークスペース
        </button>
        {activeWs?.role === "admin" && (
          <>
            <div className="my-1 border-t" style={{ borderColor: "var(--border)" }} />
            <button
              type="button"
              role="menuitem"
              onClick={inviteToWorkspace}
              disabled={wsInviteBusy}
              className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm hover:bg-[var(--hover)]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>
              {wsInviteBusy ? "作成中…" : "このワークスペースに招待リンク"}
            </button>
            {wsInviteUrl && (
              <div className="px-3 pb-2 text-[11px] break-all" style={{ color: "var(--muted)" }}>
                コピー済み。このリンクで登録するとこのワークスペースに参加します。<br />{wsInviteUrl}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await getMyProfile();
        if (alive) setProfile(p);
      } catch { /* not logged in / env not set */ }
    })();
    return () => { alive = false; };
  }, []);

  async function onAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const dataUrl = await resizeToSquareDataUrl(file);
        setProfile((p) => (p ? { ...p, avatar: dataUrl } : p));
        await updateMyAvatar(dataUrl);
      } catch { /* ignore resize / persist errors */ }
    }
    e.target.value = "";
    setMenuOpen(false);
    setMobileMenuOpen(false);
  }

  // Every path that updates the badge goes through here. Requests are ordered
  // by a token because they overlap: navigating to /notifications kicks off a
  // count fetch at the same moment the page marks everything seen, and without
  // this the older (pre-seen) response lands last and puts the badge back.
  const unreadSeq = useRef(0);
  const refreshUnread = useCallback(async () => {
    const token = ++unreadSeq.current;
    try {
      const u = await unreadCount();
      if (token === unreadSeq.current) setUnread(u);
    } catch { /* env not set yet */ }
  }, []);
  useEffect(() => {
    void refreshUnread();
    // D1 has no push; poll the badge.
    const poll = setInterval(() => { void refreshUnread(); }, 15000);
    // opening the notifications page (or reading one) drops the badge right
    // away instead of up to 15s later
    const onChanged = () => { void refreshUnread(); };
    window.addEventListener(UNREAD_CHANGED_EVENT, onChanged);
    return () => { clearInterval(poll); window.removeEventListener(UNREAD_CHANGED_EVENT, onChanged); };
  }, [pathname, refreshUnread]);

  // The searchable goal list is only for the ⌘K palette — fetching it on
  // every route change (every page already fetches its own goals) doubled
  // the workspace's full goal list on every navigation for nothing. Load it
  // once, lazily, the first time the palette actually opens.
  useEffect(() => {
    if (!paletteOpen || goals.length > 0) return;
    let alive = true;
    (async () => {
      try {
        const g = await listGoals();
        if (alive) setGoals(g);
      } catch { /* env not set yet */ }
    })();
    return () => { alive = false; };
  }, [paletteOpen, goals.length]);

  // client-side auth gate (OpenNext/Cloudflare doesn't run Node middleware).
  // Gate the whole app render on this so NOTHING shows before auth is confirmed.
  useEffect(() => {
    if (pathname.startsWith("/login")) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/auth/me", { credentials: "same-origin" });
        const d = (await r.json()) as { user?: unknown };
        if (!alive) return;
        if (d.user) {
          setAuthed(true);
        } else {
          setAuthed(false);
          router.replace("/login");
        }
      } catch { if (alive) { setAuthed(false); router.replace("/login"); } }
    })();
    return () => { alive = false; };
  }, [pathname, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); setQ(""); }
      else if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // トラックパッドの2本指右スワイプで前の画面に戻る(ブラウザの戻るジェスチャ相当)。
  // Pake製デスクトップ版のWKWebViewはネイティブの戻るジェスチャが無効なので、
  // wheelイベントの横方向オーバースクロールを自前で検出する。
  // 状態はrefに置きeffectの依存を空にする: pathnameを依存に入れると back() のたびに
  // acc/fired がリセットされ、スワイプの慣性イベントで連続backして全画面戻ってしまう。
  const swipeCtxRef = useRef({ pathname, paletteOpen });
  swipeCtxRef.current = { pathname, paletteOpen };
  useEffect(() => {
    let acc = 0;
    let fired = false;
    let resetTimer: number | undefined;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      // ジェスチャが完全に途切れて300ms経つまで fired を維持 = 1スワイプ1回だけ戻る
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => { acc = 0; fired = false; }, 300);
      if (fired) return;
      const { pathname: path, paletteOpen: palette } = swipeCtxRef.current;
      if (!path.startsWith("/goals/") || palette) return;
      // 横スクロールできる要素の上ではスクロールを奪わない
      for (let el = e.target as Element | null; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 1) return;
      }
      acc += e.deltaX;
      if (acc <= -70) { fired = true; router.back(); }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => { window.clearTimeout(resetTimer); window.removeEventListener("wheel", onWheel); };
  }, [router]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return goals;
    return goals.filter((g) => g.name.toLowerCase().includes(s));
  }, [q, goals]);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      /* ignore network errors — clear client state regardless */
    }
    setMenuOpen(false);
    setMobileMenuOpen(false);
    router.push("/login");
  }

  // Auth pages render without the app chrome (rail / topbar).
  if (pathname.startsWith("/login")) {
    return <>{children}</>;
  }

  // Do NOT render any app content until auth is confirmed (prevents content
  // from flashing for logged-out users while redirecting to /login).
  if (authed !== true) {
    return <div className="h-screen w-full" style={{ background: "var(--app-bg)" }} />;
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {activeWsId && <RealtimeBridge workspaceId={activeWsId} />}
      {/* shared hidden avatar file input (used by both desktop rail and mobile bar) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onAvatarFile}
      />
      {/* rail (desktop only) */}
      <aside className="rail hidden md:flex flex-col items-center justify-between w-16 flex-shrink-0 py-5 px-2">
        <div className="flex flex-col items-center gap-1 w-full">
          <div className="relative mb-3 mt-1">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="text-[#7c93ff]"
              aria-label="タスク一覧へ戻る"
              title="タスク一覧へ戻る"
            >
              {ICON.feather}
            </button>
          </div>
          {NAV.map((n) => (
            <Link key={n.key} href={n.href} className={`rail-item${isActive(n.href) ? " active" : ""}`}>
              <span>{n.icon}</span>
              <span>{n.label}</span>
              {n.key === "notifications" && unread > 0 && <span className="rail-badge">{unread > 99 ? "99+" : unread}</span>}
            </Link>
          ))}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="w-10 h-10 rounded-full bg-[#7bc47f] flex items-center justify-center text-white text-sm font-bold shadow overflow-hidden"
            aria-label="プロフィール"
          >
            {profile?.avatar ? (
              <img src={profile.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
            ) : (
              (profile?.name?.[0] ?? "?")
            )}
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden />
              <div
                role="menu"
                className="absolute left-12 bottom-0 z-50 w-36 card overflow-hidden py-1"
                style={{ boxShadow: "var(--shadow-pop)" }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => fileInputRef.current?.click()}
                  className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
                >
                  画像を変更
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={logout}
                  className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
                  style={{ color: "var(--danger)" }}
                >
                  ログアウト
                </button>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* right column */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="topbar h-12 flex items-center px-4 flex-shrink-0 relative">
          <button
            onClick={() => { setPaletteOpen(true); setQ(""); }}
            className="search-box mx-auto flex items-center gap-2 w-full md:w-[420px] max-w-[85%] md:max-w-[55%] h-8 px-3 text-sm"
          >
            <span className="text-white/70">{ICON.search}</span>
            <span className="text-white/60">検索</span>
          </button>
          {/*
            z-50 は必須。-translate-y-1/2 は translate プロパティを立てるので、この div は
            z-index が auto でも重ね合わせコンテキストを作る。すると中のドロップダウンの
            z-50 はこの箱の中でしか効かず、後ろに並ぶ main の中のカード (「期限が近い」など)
            に上から描かれる。箱そのものに z を振って、main より上に置く。
          */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2 z-50">
            <button
              type="button"
              onClick={() => setWsOpenTop((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={wsOpenTop}
              className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-white/90 hover:bg-white/10 text-sm max-w-[44vw]"
              aria-label="ワークスペースを切替"
            >
              <span className="w-5 h-5 rounded-md bg-white/20 text-white text-[11px] font-bold flex items-center justify-center shrink-0">{activeWs?.name?.[0] ?? "?"}</span>
              <span className="truncate hidden sm:block max-w-[18ch]">{activeWs?.name ?? "ワークスペース"}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-70 shrink-0"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {wsOpenTop && wsMenu(() => setWsOpenTop(false), "right-0 top-full mt-1")}
          </div>
        </header>
        <LoadFailureBanner />
        <main ref={mainRef} className="flex-1 min-h-0 overflow-y-auto pb-16 md:pb-0" style={{ background: "var(--app-bg)" }}>
          {children}
        </main>
      </div>

      {/* bottom nav (mobile only) */}
      <nav className="rail flex md:hidden fixed inset-x-0 bottom-0 z-30 h-16 items-stretch justify-around px-1">
        {NAV.map((n) => (
          <Link
            key={n.key}
            href={n.href}
            className={`rail-item relative flex-1 flex flex-col items-center justify-center gap-0.5${isActive(n.href) ? " active" : ""}`}
          >
            <span>{n.icon}</span>
            <span className="text-[10px] leading-none">{n.label}</span>
            {n.key === "notifications" && unread > 0 && (
              <span className="rail-badge">{unread > 99 ? "99+" : unread}</span>
            )}
          </Link>
        ))}
        <div className="relative flex-1 flex items-center justify-center">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={mobileMenuOpen}
            className="w-9 h-9 rounded-full bg-[#7bc47f] flex items-center justify-center text-white text-sm font-bold shadow overflow-hidden"
            aria-label="プロフィール"
          >
            {profile?.avatar ? (
              <img src={profile.avatar} alt="" className="w-9 h-9 rounded-full object-cover" />
            ) : (
              (profile?.name?.[0] ?? "?")
            )}
          </button>
          {mobileMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} aria-hidden />
              <div
                role="menu"
                className="absolute right-1 bottom-14 z-50 w-44 card overflow-hidden py-1"
                style={{ boxShadow: "var(--shadow-pop)" }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => fileInputRef.current?.click()}
                  className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
                >
                  画像を変更
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={logout}
                  className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
                  style={{ color: "var(--danger)" }}
                >
                  ログアウト
                </button>
              </div>
            </>
          )}
        </div>
      </nav>

      {/* new workspace modal */}
      {createOpen && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-32" style={{ background: "rgba(0,0,0,0.3)" }} onClick={() => { if (!creating) setCreateOpen(false); }}>
          <div className="w-[420px] max-w-[92vw] card overflow-hidden" style={{ boxShadow: "var(--shadow-pop)" }} onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-4 pb-2 text-[15px] font-bold">新しいワークスペース</div>
            <input
              autoFocus
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              placeholder="ワークスペース名"
              className="w-full bg-transparent px-5 py-3 text-base focus:outline-none border-y"
              style={{ borderColor: "var(--border)" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreateWs();
                else if (e.key === "Escape" && !creating) setCreateOpen(false);
              }}
            />
            <div className="flex justify-end gap-2 px-5 py-3">
              <button type="button" onClick={() => setCreateOpen(false)} disabled={creating} className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--hover)]">キャンセル</button>
              <button type="button" onClick={onCreateWs} disabled={creating || !newWsName.trim()} className="px-3 py-1.5 text-sm rounded-lg text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>{creating ? "作成中…" : "作成"}</button>
            </div>
          </div>
        </div>
      )}

      {/* command palette */}
      {paletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-28" style={{ background: "rgba(0,0,0,0.3)" }} onClick={() => setPaletteOpen(false)}>
          <div className="w-[520px] max-w-[92vw] card overflow-hidden" style={{ boxShadow: "var(--shadow-pop)" }} onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="ゴールを検索 / 移動…"
              className="w-full bg-transparent px-5 py-4 text-base focus:outline-none border-b"
              style={{ borderColor: "var(--border)" }}
              onKeyDown={(e) => { if (e.key === "Enter" && filtered[0]) { router.push(`/goals/${filtered[0].id}`); setPaletteOpen(false); } }}
            />
            <div className="max-h-80 overflow-y-auto py-2">
              {filtered.length === 0 ? (
                <div className="px-5 py-3 text-sm text-[var(--muted)]">該当なし</div>
              ) : filtered.map((g) => (
                <button key={g.id} onClick={() => { router.push(`/goals/${g.id}`); setPaletteOpen(false); }}
                  className="block w-full text-left px-5 py-2.5 text-[15px] hover:bg-[var(--hover)]">
                  {g.emoji && <span className="mr-2">{g.emoji}</span>}{g.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
