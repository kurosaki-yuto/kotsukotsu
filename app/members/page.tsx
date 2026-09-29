"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listMembers,
  rankedMembers,
  createInvite,
  removeMember,
  createResetLink,
  type ResetLinkResult,
  updateMember,
  getMe,
  listMemberGoals,
  listGoals,
  assignGoalMember,
  unassignGoalMember,
  getMemberTaskProgress,
  type Me,
  type MemberGoal,
  type MemberProgress,
} from "../lib/addness";
import type { Member, Goal } from "../lib/db";
import { supabase } from "../lib/db";

function firstChar(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

function formatJoined(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function PersonPlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );
}

function TrophyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function ThumbsUpGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  );
}

function CalendarGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function AlertGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function Avatar({ member, size }: { member: Member; size: number }) {
  const bg = "#e3f3e4";
  const fg = "#3f8a47";
  if (member.avatar) {
    return (
      <img
        src={member.avatar}
        alt={member.name}
        className="rounded-full object-cover select-none shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-full font-semibold select-none shrink-0"
      style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.42 }}
    >
      {firstChar(member.name)}
    </div>
  );
}

function YouPill() {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-tight"
      style={{ background: "#eef0f2", color: "var(--muted)" }}
    >
      あなた
    </span>
  );
}

function StatPill({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] leading-none"
      style={{ background: "var(--hover)", color: color ?? "var(--muted)" }}
    >
      {children}
    </span>
  );
}

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [ranking, setRanking] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [progress, setProgress] = useState<Record<string, MemberProgress>>({});
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const admin = me?.role === "admin";
  // the signed-in viewer's email, lowercased — basis for per-viewer "あなた" detection
  const meEmail = me?.email?.toLowerCase();
  // a member is "you" only when both emails are present and match (case-insensitive)
  const isYou = useCallback(
    (m: Member) => !!meEmail && !!m.email && m.email.toLowerCase() === meEmail,
    [meEmail]
  );
  const router = useRouter();

  // ---- 配属タスク (assigned tasks for the selected member) ----
  const [memberGoals, setMemberGoals] = useState<MemberGoal[]>([]);
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  const [assignGoalId, setAssignGoalId] = useState("");
  const [grantEdit, setGrantEdit] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);

  const loadMemberGoals = useCallback(async (memberId: string) => {
    try {
      const rows = await listMemberGoals(memberId);
      setMemberGoals(rows);
    } catch (e: unknown) {
      setMemberGoals([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // load the selected member's assigned tasks whenever the selection changes
  useEffect(() => {
    if (!selectedId) {
      setMemberGoals([]);
      return;
    }
    setAssignGoalId("");
    setGrantEdit(false);
    void loadMemberGoals(selectedId);
  }, [selectedId, loadMemberGoals]);

  // load the full goal list once (admin needs it for the assign dropdown)
  useEffect(() => {
    if (!admin) return;
    let alive = true;
    (async () => {
      try {
        const rows = await listGoals();
        if (alive) setAllGoals(rows);
      } catch {
        /* tolerate; dropdown simply stays empty */
      }
    })();
    return () => {
      alive = false;
    };
  }, [admin]);

  // admin dashboard: who still has undone assigned tasks
  const loadProgress = useCallback(async () => {
    if (!admin) { setProgress({}); return; }
    try {
      const rows = await getMemberTaskProgress();
      setProgress(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch {
      /* tolerate; badges simply stay hidden */
    }
  }, [admin]);
  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  // goals sorted parents-first with children indented under them
  const goalOptions = useMemo(() => {
    const byParent = new Map<string | null, Goal[]>();
    for (const g of allGoals) {
      const key = g.parent_goal_id ?? null;
      const bucket = byParent.get(key);
      if (bucket) bucket.push(g);
      else byParent.set(key, [g]);
    }
    const out: { goal: Goal; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const g of byParent.get(parent) ?? []) {
        out.push({ goal: g, depth });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    // include any orphans whose parent isn't in the list
    const seen = new Set(out.map((o) => o.goal.id));
    for (const g of allGoals) {
      if (!seen.has(g.id)) out.push({ goal: g, depth: 0 });
    }
    return out;
  }, [allGoals]);

  const handleAssign = async () => {
    if (!selected || !assignGoalId || assignBusy) return;
    setAssignBusy(true);
    try {
      await assignGoalMember(assignGoalId, selected.id, grantEdit);
      setAssignGoalId("");
      setGrantEdit(false);
      await loadMemberGoals(selected.id);
      await loadProgress();
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssignBusy(false);
    }
  };

  const handleUnassign = async (goalId: string) => {
    if (!selected) return;
    try {
      await unassignGoalMember(goalId, selected.id);
      await loadMemberGoals(selected.id);
      await loadProgress();
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { user } = await getMe();
        if (alive) setMe(user);
      } catch {
        /* tolerate; treat as non-admin */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const rows = ranking ? await rankedMembers() : await listMembers();
      setMembers(rows);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ranking]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof supabase>["channel"]> | null = null;
    try {
      channel = supabase()
        .channel("members-page")
        .on("postgres_changes", { event: "*", schema: "public", table: "members" }, () => {
          void reload();
        })
        .subscribe();
    } catch {
      /* env not set — page already surfaces error via reload */
    }
    return () => {
      if (channel) void supabase().removeChannel(channel);
    };
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = q ? members.filter((m) => m.name.toLowerCase().includes(q)) : members;
    if (pendingOnly) base = base.filter((m) => (progress[m.id]?.pending ?? 0) > 0);
    if (pendingOnly) return [...base].sort((a, b) => (progress[b.id]?.pending ?? 0) - (progress[a.id]?.pending ?? 0));
    if (!meEmail) return base;
    // float the current viewer to the top by email match (stable for everyone else)
    return [...base].sort((a, b) => Number(isYou(b)) - Number(isYou(a)));
  }, [members, query, meEmail, isYou, pendingOnly, progress]);

  const selected = useMemo(
    () => members.find((m) => m.id === selectedId) ?? null,
    [members, selectedId]
  );

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const { url } = await createInvite(inviteEmail.trim() || undefined, inviteRole);
      setInviteUrl(url);
      setInviteCopied(false);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copyInviteUrl = () => {
    if (!inviteUrl) return;
    try {
      navigator.clipboard?.writeText(inviteUrl);
    } catch {
      /* clipboard unavailable */
    }
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 1500);
  };

  const handleRemove = async (id: string) => {
    try {
      await removeMember(id);
      setSelectedId((cur) => (cur === id ? null : cur));
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // パスワード再設定リンク (管理者が発行し、本人の登録メールアドレスへ送る)。メンバーを切り替えたら消す。
  const [resetLink, setResetLink] = useState<({ id: string } & ResetLinkResult) | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetCopied, setResetCopied] = useState(false);
  const issueResetLink = async (m: Member) => {
    if (!window.confirm(`${m.name} さんの登録メールアドレスに、パスワード再設定のリンクを送りますか？\n前に発行したリンクは使えなくなります。`)) return;
    setResetBusy(true);
    try {
      const r = await createResetLink(m.id);
      setResetLink({ id: m.id, ...r });
      setResetCopied(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetBusy(false);
    }
  };
  const copyResetLink = () => {
    if (!resetLink) return;
    try { navigator.clipboard?.writeText(resetLink.url); } catch { /* clipboard unavailable */ }
    setResetCopied(true);
    setTimeout(() => setResetCopied(false), 1500);
  };

  const toggleRole = async (m: Member) => {
    const next = m.role === "Admin" ? "None" : "Admin";
    try {
      await updateMember(m.id, { role: next });
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-1 min-h-0 h-screen" style={{ background: "var(--app-bg)" }}>
      {/* LEFT: list pane */}
      <aside
        className={`${
          selected ? "hidden md:flex" : "flex"
        } w-full md:w-[440px] flex-col min-h-0 md:shrink-0 border-r`}
        style={{ background: "var(--background)", borderColor: "var(--border)" }}
      >
        {/* header: title + viewer role */}
        <div
          className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <h1 className="text-[16px] font-semibold leading-none" style={{ color: "var(--foreground)" }}>
            メンバー
          </h1>
          <span
            className="inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none"
            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
          >
            あなた: {admin ? "管理者" : "メンバー"}
          </span>
        </div>

        {/* toolbar: search + actions */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="メンバーを検索"
            className="min-w-0 flex-1 rounded-lg px-3 py-2 text-[15px] focus:outline-none border"
            style={{ background: "var(--hover)", borderColor: "var(--border)", color: "var(--foreground)" }}
          />
          {admin && (
            <button
              type="button"
              className={`chip flex-none${inviteOpen ? " active" : ""}`}
              onClick={() => setInviteOpen((v) => !v)}
            >
              <PersonPlusGlyph />
              招待
            </button>
          )}
          <button
            type="button"
            className={`chip flex-none${ranking ? " active" : ""}`}
            onClick={() => setRanking((v) => !v)}
          >
            <TrophyGlyph />
            ランキング
          </button>
          {admin && (
            <button
              type="button"
              className={`chip flex-none${pendingOnly ? " active" : ""}`}
              onClick={() => setPendingOnly((v) => !v)}
              title="配属タスクが未完了のメンバーだけ表示"
            >
              <AlertGlyph />
              未完了
            </button>
          )}
        </div>

        {/* invite form */}
        {admin && inviteOpen && (
          <form
            onSubmit={submitInvite}
            className="flex flex-col gap-2 px-4 py-3 border-b"
            style={{ borderColor: "var(--border)", background: "var(--hover)" }}
          >
            <input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="メールアドレス（任意）"
              type="email"
              className="rounded-lg px-3 py-2 text-[15px] focus:outline-none border"
              style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
              className="rounded-lg px-3 py-2 text-[15px] focus:outline-none border"
              style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
            >
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
            </select>
            <div className="flex justify-end">
              <button type="submit" className="btn-dark" disabled={submitting}>
                {submitting ? "作成中…" : "招待リンクを作成"}
              </button>
            </div>

            {inviteUrl && (
              <div className="flex flex-col gap-1.5">
                <div
                  className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
                  style={{ background: "var(--background)", borderColor: "var(--border)" }}
                >
                  <input
                    readOnly
                    value={inviteUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 truncate bg-transparent font-mono text-[12px] outline-none"
                    style={{ color: "var(--foreground)" }}
                  />
                  <button type="button" className="chip flex-none" onClick={copyInviteUrl}>
                    {inviteCopied ? "コピー済" : "コピー"}
                  </button>
                </div>
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>
                  リンクを共有してください。相手が登録するとメンバーに追加されます。
                </p>
              </div>
            )}
          </form>
        )}

        {error && (
          <div className="px-4 py-2 text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </div>
        )}

        {/* member rows */}
        <div className="flex-1 min-h-0 overflow-y-auto pb-24 md:pb-0">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-[14px]" style={{ color: "var(--muted)" }}>
              メンバーがいません
            </div>
          ) : (
            filtered.map((m, i) => {
              const active = m.id === selectedId;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedId(m.id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
                  style={{ background: active ? "var(--selected)" : "transparent" }}
                  onMouseEnter={(e) => {
                    if (!active) (e.currentTarget as HTMLButtonElement).style.background = "var(--hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                >
                  {ranking && (
                    <span
                      className="w-6 flex-none text-center text-[13px] font-semibold tabular-nums"
                      style={{ color: i < 3 ? "var(--accent)" : "var(--muted-soft)" }}
                    >
                      #{i + 1}
                    </span>
                  )}
                  <Avatar member={m} size={40} />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium" style={{ color: "var(--foreground)" }}>
                      {m.name}
                    </span>
                    {isYou(m) && <YouPill />}
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    {admin && (progress[m.id]?.pending ?? 0) > 0 && (
                      <StatPill color="var(--danger)">
                        <AlertGlyph />
                        {progress[m.id]!.pending}
                      </StatPill>
                    )}
                    <StatPill>
                      <ThumbsUpGlyph />
                      {m.points}
                    </StatPill>
                    <StatPill>
                      <CalendarGlyph />
                      {m.streak}
                    </StatPill>
                    <span className="flex-none" style={{ color: "var(--muted-soft)" }}>
                      <ChevronGlyph />
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* RIGHT: detail pane */}
      <section
        className={`${
          selected ? "flex" : "hidden md:flex"
        } flex-1 min-h-0 flex-col`}
        style={{ background: "var(--background)" }}
      >
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-[15px]" style={{ color: "var(--muted)" }}>
            一覧からメンバーを選択してください
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-10 pb-24 md:pb-10">
            {/* mobile-only back button to return to the list */}
            <button
              type="button"
              className="md:hidden chip self-start"
              onClick={() => setSelectedId(null)}
            >
              ← 戻る
            </button>
            <div className="flex items-center gap-4">
              <Avatar member={selected} size={72} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="min-w-0 truncate text-2xl font-semibold" style={{ color: "var(--foreground)" }}>
                    {selected.name}
                  </h1>
                  {isYou(selected) && <YouPill />}
                </div>
                <div className="text-[14px]" style={{ color: "var(--muted)" }}>
                  {selected.role === "Admin" ? "管理者" : "メンバー"}
                </div>
                <div className="text-[13px]" style={{ color: "var(--muted-soft)" }}>
                  登録日 {formatJoined(selected.joined_at)}
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="card flex-1 px-5 py-4">
                <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                  達成ポイント
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
                  {selected.points}
                </div>
              </div>
              <div className="card flex-1 px-5 py-4">
                <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                  連続日数
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
                  {selected.streak}
                </div>
              </div>
            </div>

            {admin && !isYou(selected) && (
              <div className="flex items-center gap-4">
                <button type="button" className="chip" onClick={() => void toggleRole(selected)}>
                  権限: {selected.role === "Admin" ? "Admin" : "None"}
                </button>
                <button type="button" className="chip" disabled={resetBusy} onClick={() => void issueResetLink(selected)}>
                  {resetBusy ? "送信中…" : "パスワード再設定リンクを送る"}
                </button>
                <button
                  type="button"
                  className="text-[13px] font-medium"
                  style={{ color: "var(--danger)" }}
                  onClick={() => void handleRemove(selected.id)}
                >
                  除外
                </button>
              </div>
            )}

            {admin && resetLink && resetLink.id === selected.id && (
              <div className="card px-4 py-3">
                <div className="text-[12.5px] font-semibold mb-2" style={{ color: "var(--foreground)" }}>
                  パスワード再設定リンク
                </div>
                {resetLink.mailed_to ? (
                  <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--foreground)" }}>
                    {resetLink.mailed_to} 宛にメールで送りました。
                  </p>
                ) : (
                  <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--danger)" }}>
                    メールで送れませんでした ({resetLink.mail_error ?? "理由不明"})。下のリンクを LINE や Chatwork で本人にだけ送ってください。
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <input
                    readOnly
                    value={resetLink.url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 truncate rounded-md border px-2.5 py-1.5 font-mono text-[12px] outline-none"
                    style={{ borderColor: "var(--border)" }}
                  />
                  <button type="button" className="btn-dark shrink-0 px-3 py-1.5 text-[12.5px]" onClick={copyResetLink}>
                    {resetCopied ? "コピー済" : "コピー"}
                  </button>
                </div>
                <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                  メールが届かないときは、このリンクを本人にだけ渡してください。開くと新しいパスワードを決められます。
                  有効期限は {new Date(resetLink.expires_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} まで・1回限り。
                  使うと、その人の他の端末はログアウトされます。
                </p>
              </div>
            )}

            {/* 配属タスク (assigned tasks) */}
            <div className="flex flex-col gap-3">
              <div className="text-[13px] font-semibold" style={{ color: "var(--foreground)" }}>
                配属タスク
              </div>

              {memberGoals.length === 0 ? (
                <div className="text-[13px]" style={{ color: "var(--muted)" }}>
                  まだアサインされていません
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {memberGoals.map((g) => (
                    <li
                      key={g.id}
                      className="card flex items-center gap-2 px-3 py-2"
                    >
                      <span className="shrink-0 text-[15px] leading-none">{g.emoji ?? "・"}</span>
                      <button
                        type="button"
                        onClick={() => router.push(`/goals/${g.id}`)}
                        className="min-w-0 flex-1 truncate text-left text-[14px] font-medium hover:underline"
                        style={{ color: "var(--foreground)" }}
                      >
                        {g.name}
                      </button>
                      {admin && (
                        <button
                          type="button"
                          className="shrink-0 text-[12px] font-medium"
                          style={{ color: "var(--danger)" }}
                          onClick={() => void handleUnassign(g.id)}
                        >
                          解除
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {admin && (
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <select
                      value={assignGoalId}
                      onChange={(e) => setAssignGoalId(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg px-3 py-2 text-[14px] focus:outline-none border"
                      style={{ background: "var(--hover)", borderColor: "var(--border)", color: "var(--foreground)" }}
                    >
                      <option value="">タスクを選択…</option>
                      {goalOptions.map(({ goal, depth }) => (
                        <option key={goal.id} value={goal.id}>
                          {`${"　".repeat(depth)}${goal.emoji ? `${goal.emoji} ` : ""}${goal.name}`}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn-dark flex-none"
                      disabled={!assignGoalId || assignBusy}
                      onClick={() => void handleAssign()}
                    >
                      {assignBusy ? "配属中…" : "配属"}
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--muted)" }}>
                    <input
                      type="checkbox"
                      checked={grantEdit}
                      onChange={(e) => setGrantEdit(e.target.checked)}
                    />
                    編集権限を付与
                  </label>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
