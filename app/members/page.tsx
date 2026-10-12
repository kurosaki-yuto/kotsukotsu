"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { listMembers, createInvite, removeMember, updateMember, getMe, getMemberTaskProgress, getDoneCounts, type Me, type MemberProgress } from "../lib/addness";
import type { Member, Goal } from "../lib/db";
import { useAutoRefresh } from "../lib/useAutoRefresh";
import { MemberDetail } from "./MemberDetail";
import { Avatar, YouPill, StatPill, PersonPlusGlyph, TrophyGlyph, ThumbsUpGlyph, CalendarGlyph, CheckGlyph, AlertGlyph, ChevronGlyph } from "./glyphs";

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [ranking, setRanking] = useState(false);
  // ランキングの並べ方。既定は今日終えたタスクの数 (同数は名前順)
  const [rankBy, setRankBy] = useState<"today" | "week" | "points">("today");
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

  // 今日・今週に終えたタスクの数 (タスク画面の「終えたタスク」と同じ /api/done-counts)。数はメンバー全員が全員分見られる
  const [done, setDone] = useState<Record<string, { today: number; week: number }>>({});
  const loadDone = useCallback(async () => {
    try {
      const d = await getDoneCounts();
      setDone(Object.fromEntries(d.members.map((m) => [m.email.toLowerCase(), { today: m.today, week: m.week }])));
    } catch {
      /* api() が上部のバナーで知らせる */
    }
  }, []);
  useEffect(() => {
    void loadDone();
  }, [loadDone]);
  useAutoRefresh(() => { void loadDone(); }, { intervalMs: 60000 });
  const doneOf = useCallback((m: Member) => (m.email ? done[m.email.toLowerCase()] : undefined), [done]);

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
      const rows = await listMembers();
      setMembers(rows);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);


  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = q ? members.filter((m) => m.name.toLowerCase().includes(q)) : members;
    if (pendingOnly) base = base.filter((m) => (progress[m.id]?.pending ?? 0) > 0);
    if (pendingOnly) return [...base].sort((a, b) => (progress[b.id]?.pending ?? 0) - (progress[a.id]?.pending ?? 0));
    if (ranking) {
      // 順位を付けるので「あなた」を先頭に浮かせない
      const score = (m: Member) => (rankBy === "points" ? m.points : (doneOf(m)?.[rankBy] ?? 0));
      return [...base].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, "ja"));
    }
    if (!meEmail) return base;
    // float the current viewer to the top by email match (stable for everyone else)
    return [...base].sort((a, b) => Number(isYou(b)) - Number(isYou(a)));
  }, [members, query, meEmail, isYou, pendingOnly, progress, ranking, rankBy, doneOf]);

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
    // 高さは main に合わせる (h-screen だと上のバーの分はみ出し、下のナビに最後の行が隠れていた)
    <div className="flex flex-1 min-h-0 h-full" style={{ background: "var(--app-bg)" }}>
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

        {ranking && !pendingOnly && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b text-[12px]" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
            並べ方
            <div className="tab-seg" role="tablist" aria-label="ランキングの並べ方">
              {([["today", "今日終えた数"], ["week", "今週終えた数"], ["points", "達成ポイント"]] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={rankBy === k} className={rankBy === k ? "active" : ""} onClick={() => setRankBy(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

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
                  <div className="min-w-0 flex-1 select-all break-all font-mono text-[12px]" style={{ color: "var(--foreground)" }}>
                    {inviteUrl}
                  </div>
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
                  {/* 名前を1行目、数字を2行目に置く (一覧の幅が狭く、横に並べると名前が潰れる) */}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="min-w-0 break-words font-medium" style={{ color: "var(--foreground)" }}>
                      {m.name}
                    </span>
                    {isYou(m) && <span className="flex-none"><YouPill /></span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {admin && (progress[m.id]?.pending ?? 0) > 0 && (
                      <StatPill color="var(--danger)">
                        <AlertGlyph />
                        {progress[m.id]!.pending}
                      </StatPill>
                    )}
                    {doneOf(m) && (() => {
                      // 今週の数で並べているときは今週の数を出す
                      const week = ranking && rankBy === "week";
                      const n = week ? doneOf(m)!.week : doneOf(m)!.today;
                      return (
                        <span title={`${week ? "今週" : "今日"}終えたタスク ${n}件`}>
                          <StatPill color={n ? "var(--done-strong)" : undefined}>
                            <CheckGlyph />
                            {week ? "今週" : "今日"} {n}
                          </StatPill>
                        </span>
                      );
                    })()}
                    <StatPill>
                      <ThumbsUpGlyph />
                      {m.points}
                    </StatPill>
                    <StatPill>
                      <CalendarGlyph />
                      {m.streak}
                    </StatPill>
                  </div>
                  </div>
                  <span className="flex-none" style={{ color: "var(--muted-soft)" }}>
                    <ChevronGlyph />
                  </span>
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
        } min-w-0 flex-1 min-h-0 flex-col`}
        style={{ background: "var(--background)" }}
      >
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-[15px]" style={{ color: "var(--muted)" }}>
            一覧からメンバーを選択してください
          </div>
        ) : (
          <MemberDetail
            member={selected}
            admin={!!admin}
            isYou={isYou(selected)}
            done={doneOf(selected)}
            onError={setError}
            onRemove={() => void handleRemove(selected.id)}
            onToggleRole={() => void toggleRole(selected)}
            onBack={() => setSelectedId(null)}
            onProgressChanged={loadProgress}
          />
        )}
      </section>
    </div>
  );
}
