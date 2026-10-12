"use client";

// ゴール詳細ヘッダーの担当者ゾーン (担当の表示・アサイン/解除・編集許可・このタスクだけの招待リンク)。app/goals/[id]/page.tsx から切り出し。
import { useCallback, useState } from "react";
import { assignGoalMember, unassignGoalMember, setGoalMemberEdit, createGoalInvite, type GoalMember } from "../../lib/addness";
import type { Member } from "../../lib/db";
import { Assignees, Avatar } from "../Assignees";
import { I } from "./Icon";

export function AssignPanel({ goalId, assignees, members, canManage, loadAssignees, ensureMembers }: {
  goalId: string;
  assignees: GoalMember[];
  members: Member[];
  canManage: boolean;
  loadAssignees: () => Promise<void>;
  /** パネルを開いたときにメンバー一覧を読む (読み込み失敗時の再取得) */
  ensureMembers: () => Promise<void>;
}) {
  const id = goalId;
  const [assignPanel, setAssignPanel] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const openAssignPanel = useCallback(async () => {
    setAssignPanel((v) => !v);
    if (members.length === 0) await ensureMembers();
  }, [members.length, ensureMembers]);

  const toggleAssign = useCallback(async (memberId: string, assigned: boolean) => {
    try {
      if (assigned) await unassignGoalMember(id, memberId);
      else await assignGoalMember(id, memberId, false);
      await loadAssignees();
    } catch (e) { console.error(e); }
  }, [id, loadAssignees]);

  const toggleEdit = useCallback(async (memberId: string, canEdit: boolean) => {
    try { await setGoalMemberEdit(id, memberId, canEdit); await loadAssignees(); } catch (e) { console.error(e); }
  }, [id, loadAssignees]);

  // Create an invite link that only grants access to THIS task and its subtree.
  const makeInvite = useCallback(async () => {
    setInviteBusy(true);
    try {
      const { url } = await createGoalInvite(id);
      if (url) {
        setInviteUrl(url);
        try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
      }
    } catch (e) { console.error(e); }
    finally { setInviteBusy(false); }
  }, [id]);

  return (
    <div className="relative flex items-center gap-1.5">
      {assignees.length > 0 ? (
        canManage ? (
          <button onClick={openAssignPanel} className="flex items-center rounded-full px-1 py-0.5 hover:bg-[var(--hover)]" aria-label="担当を変更" title="担当を変更">
            <Assignees members={assignees} size={26} max={4} withName showLock />
          </button>
        ) : (
          <Assignees members={assignees} size={26} max={4} withName showLock />
        )
      ) : (
        canManage && <span className="text-[12px] text-[var(--muted-soft)]">未アサイン</span>
      )}
      {canManage && (
        <button onClick={openAssignPanel} className="w-7 h-7 shrink-0 rounded-full border border-dashed flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)]"
          style={{ borderColor: "var(--border-strong)" }} aria-label="メンバーをアサイン"><I d="M12 5v14M5 12h14" /></button>
      )}
      {assignPanel && canManage && (() => {
        // 自分も候補に出す。以前は自分を除いていたが、そうすると自分が持つタスクに
        // 自分をアサインできない (下の行に「(自分)」の表示があるとおり、元々は
        // 出す作りだった)。アサインは担当を明示するためのもので、自分だけ例外に
        // する理由が無い。2026-09-09 黒崎指示。
        const assignable = members;
        return (
        <div className="absolute right-0 top-9 z-30 card w-[min(18rem,calc(100vw-2rem))] max-w-[18rem] max-h-80 overflow-y-auto" style={{ boxShadow: "var(--shadow-pop)" }} onMouseLeave={() => setAssignPanel(false)}>
          <div className="px-4 py-2.5 border-b text-[12px] font-bold text-[var(--muted)]" style={{ borderColor: "var(--border)" }}>メンバーをアサイン</div>
          {assignable.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-[var(--muted-soft)]">メンバーがいません</div>
          ) : (
            <ul className="py-1">
              {assignable.map((m) => {
                const g = assignees.find((a) => a.id === m.id);
                const assigned = !!g;
                return (
                  <li key={m.id} className="px-3 py-2 hover:bg-[var(--hover)]">
                    <div className="flex items-center gap-2.5">
                      <Avatar member={{ id: m.id, name: m.name, email: m.email, avatar: m.avatar, can_edit: assigned ? !!g?.can_edit : undefined }} size={24} />
                      <span className="flex-1 text-[13.5px] truncate" title={m.name}>{m.name}{m.is_you && <span className="ml-1 text-[var(--muted-soft)]">(自分)</span>}</span>
                      <button onClick={() => toggleAssign(m.id, assigned)}
                        className={assigned ? "chip text-[var(--danger)]" : "chip"}>
                        {assigned ? "解除" : "アサイン"}
                      </button>
                    </div>
                    {assigned && (
                      <label className="flex items-center gap-1.5 mt-1.5 ml-[34px] text-[12px] text-[var(--muted)] cursor-pointer select-none">
                        <input type="checkbox" checked={!!g?.can_edit} onChange={(e) => toggleEdit(m.id, e.target.checked)} className="accent-[var(--accent)]" />
                        {g?.can_edit ? "編集を許可" : "閲覧のみ"}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
            <button onClick={makeInvite} disabled={inviteBusy} className="chip w-full justify-center">{inviteBusy ? "作成中…" : "このタスクに招待リンク"}</button>
            {inviteUrl && (
              <div className="mt-2 text-[11px] break-all" style={{ color: "var(--muted)" }}>
                コピー済み。招待された人はこのタスク以下だけ操作できます。<br />{inviteUrl}
              </div>
            )}
          </div>
        </div>
        );
      })()}
    </div>
  );
}
