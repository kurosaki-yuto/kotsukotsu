"use client";

import { useState } from "react";
import { setStepDone, dismissAttention, type TaskStep } from "../../lib/addness";
import type { Goal } from "../../lib/db";

// タスク詳細の「作業の手順」と「止まっている」の知らせ (2026-11-01)。
// 手順は AI が作業を始めるときに切るもの。子タスクにすると人が頼んだタスクと同じ盤に並んでしまうので、
// タスクの中のチェックリストとして見せる。手順が無ければ何も出さない。
export function StepsPanel({ goal, steps, onChanged }: { goal: Goal; steps: TaskStep[]; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const done = steps.filter((s) => s.done_at).length;
  const toggle = async (s: TaskStep) => {
    setBusy(s.id);
    try { await setStepDone(s.id, !s.done_at, goal.id); await onChanged(); } catch { /* api() がバナーを出す */ } finally { setBusy(null); }
  };
  const ack = async () => {
    setBusy("stall");
    try { await dismissAttention(goal.id, "ack_stall"); await onChanged(); } catch { /* バナー */ } finally { setBusy(null); }
  };
  if (!steps.length && !goal.stalled_at) return null;
  return (
    <div className="mt-4 mb-3 space-y-3">
      {goal.stalled_at && goal.status === "active" && (
        <div className="card flex items-start gap-3 px-4 py-3" style={{ borderColor: "var(--border-strong)" }}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold cjk" style={{ color: "var(--danger)" }}>止まっている</div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{goal.stalled_note}</div>
          </div>
          <button type="button" onClick={() => void ack()} disabled={busy === "stall"} className="chip shrink-0" title="止まっている印を消す (タスクはそのまま)">確認した</button>
        </div>
      )}
      {steps.length > 0 && (
        <div className="card px-4 py-2">
          <div className="flex items-baseline gap-2 py-1.5">
            <span className="text-[13px] font-bold cjk">作業の手順</span>
            <span className="text-[12px]" style={{ color: "var(--muted)" }}>{done}/{steps.length}</span>
            <span className="ml-auto hidden sm:inline text-[11.5px]" style={{ color: "var(--muted-soft)" }}>AI が作業を始めるときに切った手順</span>
          </div>
          <ul>
            {steps.map((s) => (
              <li key={s.id}>
                <label className="flex items-start gap-2.5 py-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!s.done_at}
                    disabled={busy === s.id}
                    onChange={() => void toggle(s)}
                    className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--done)]"
                  />
                  <span className={`min-w-0 break-words text-[13.5px] leading-relaxed ${s.done_at ? "line-through text-[var(--muted)]" : ""}`}>{s.text}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
