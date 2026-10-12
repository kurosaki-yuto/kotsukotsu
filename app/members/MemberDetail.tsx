"use client";

// メンバー画面の右ペイン (選んだメンバーの詳細・配属タスク・権限・再設定リンク)。members/page.tsx から切り出し。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { listMemberGoals, listGoals, assignGoalMember, unassignGoalMember, createResetLink, type ResetLinkResult, type MemberGoal } from "../lib/addness";
import type { Member, Goal } from "../lib/db";
import { Avatar, YouPill, formatJoined } from "./glyphs";

export function MemberDetail({ member, admin, isYou, done, onError, onRemove, onToggleRole, onBack, onProgressChanged }: {
  member: Member;
  admin: boolean;
  isYou: boolean;
  done: { today: number; week: number } | undefined;
  onError: (msg: string | null) => void;
  onRemove: () => void;
  onToggleRole: () => void;
  onBack: () => void;
  onProgressChanged: () => Promise<void> | void;
}) {
  const router = useRouter();
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
      onError(err instanceof Error ? err.message : String(err));
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

  // ---- 配属タスク (assigned tasks for the member member) ----
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
      onError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // メンバーを切り替えたら、そのメンバーの配属タスクを読み直し、入力欄と再設定リンクを消す
  useEffect(() => {
    setAssignGoalId("");
    setGrantEdit(false);
    setResetLink(null);
    void loadMemberGoals(member.id);
  }, [member.id, loadMemberGoals]);

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
    if (!assignGoalId || assignBusy) return;
    setAssignBusy(true);
    try {
      await assignGoalMember(assignGoalId, member.id, grantEdit);
      setAssignGoalId("");
      setGrantEdit(false);
      await loadMemberGoals(member.id);
      await onProgressChanged();
      onError(null);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssignBusy(false);
    }
  };

  const handleUnassign = async (goalId: string) => {
    try {
      await unassignGoalMember(goalId, member.id);
      await loadMemberGoals(member.id);
      await onProgressChanged();
      onError(null);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
          // min-w-0: 中身 (長いタスク名の選択肢など) に押されて画面より広がり、横スクロールになるのを防ぐ
          <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden p-4 md:p-10 pb-24 md:pb-10">
            {/* mobile-only back button to return to the list */}
            {/* .chip の display が md:hidden より強く PC でも出ていたので、外側の箱で隠す */}
            <div className="md:hidden">
              <button
                type="button"
                className="chip"
                onClick={() => onBack()}
              >
                ← 戻る
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-4">
              <Avatar member={member} size={72} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="min-w-0 break-words text-2xl font-semibold" style={{ color: "var(--foreground)" }}>
                    {member.name}
                  </h1>
                  {isYou && <YouPill />}
                </div>
                <div className="text-[14px]" style={{ color: "var(--muted)" }}>
                  {member.role === "Admin" ? "管理者" : "メンバー"}
                </div>
                <div className="text-[13px]" style={{ color: "var(--muted-soft)" }}>
                  登録日 {formatJoined(member.joined_at)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
              {done && (
                <>
                  <div className="card min-w-0 px-4 py-3 md:px-5 md:py-4">
                    <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                      今日終えたタスク
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: "var(--done-strong)" }}>
                      {done!.today}
                    </div>
                  </div>
                  <div className="card min-w-0 px-4 py-3 md:px-5 md:py-4">
                    <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                      今週終えたタスク
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: "var(--done-strong)" }}>
                      {done!.week}
                    </div>
                  </div>
                </>
              )}
              <div className="card min-w-0 px-4 py-3 md:px-5 md:py-4">
                <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                  達成ポイント
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
                  {member.points}
                </div>
              </div>
              <div className="card min-w-0 px-4 py-3 md:px-5 md:py-4">
                <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                  連続日数
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
                  {member.streak}
                </div>
              </div>
            </div>
            {done && (
              <p className="-mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                今週は月曜から。数え方はタスク画面の「終えたタスク」と同じです。
              </p>
            )}

            {admin && !isYou && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <button type="button" className="chip" onClick={() => void onToggleRole()}>
                  権限: {member.role === "Admin" ? "Admin" : "None"}
                </button>
                <button type="button" className="chip" disabled={resetBusy} onClick={() => void issueResetLink(member)}>
                  {resetBusy ? "送信中…" : "パスワード再設定リンクを送る"}
                </button>
                <button
                  type="button"
                  className="text-[13px] font-medium"
                  style={{ color: "var(--danger)" }}
                  onClick={() => void onRemove()}
                >
                  除外
                </button>
              </div>
            )}

            {admin && resetLink && resetLink.id === member.id && (
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
                  <div className="min-w-0 flex-1 select-all break-all rounded-md border px-2.5 py-1.5 font-mono text-[12px]" style={{ borderColor: "var(--border)" }}>
                    {resetLink.url}
                  </div>
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
                        className="min-w-0 flex-1 break-words text-left text-[14px] font-medium hover:underline"
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
                      className="w-0 min-w-0 flex-1 rounded-lg px-3 py-2 text-[14px] focus:outline-none border"
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
  );
}
