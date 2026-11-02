"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getDoneCounts, prefetchGoalBundle,
  type DoneCounts,
} from "../lib/addness";
import { useAutoRefresh } from "../lib/useAutoRefresh";
import { DoneCountsBody, myDoneToday } from "./DoneCounts";

// タスク画面の上の段 (2026-11-02 黒崎「開いた状態やからスクロールずっとしなあかんのがクソめんどい」)。
// 期限切れ・近い と 今日終えた を件数つきの札で出す (黒崎判断 2026-11-02: あなたの番・止まっている・閉じていい？ は盤に出さず、AI が status_report で会話で出す)。
// 開いた直後は全部閉じていて、すぐ下にゴールのツリーが見える。札を押すとその1つだけ下に開き、もう一度押すと閉じる。
// 開け閉めは覚えない (毎回閉じた状態から始める)。0件の札は出さない。
// 読み込みに失敗したら api() が上部のバナーで知らせる (空と区別するため)。前の表示は残す。
export type DeadlineItem = { id: string; name: string; emoji: string | null; daysLeft: number };
type Key = "deadlines" | "done";
type Tone = { fg: string; border: string; bg: string };

const TONE: Record<Key, Tone> = {
  deadlines: { fg: "var(--foreground-soft)", border: "var(--border-strong)", bg: "var(--surface)" },
  done: { fg: "var(--done-strong)", border: "var(--done-border)", bg: "var(--done-soft)" },
};
const HINT: Record<Key, string> = {
  deadlines: "あなたの担当で、期限切れか3日以内のもの",
  done: "メンバー全員の今日・今週の完了数",
};

export default function BoardSummary({ myEmail, deadlines }: { myEmail: string | null; deadlines: DeadlineItem[] }) {
  const [done, setDone] = useState<DoneCounts | null>(null);
  const [open, setOpen] = useState<Key | null>(null);

  const loadDone = useCallback(async () => { try { setDone(await getDoneCounts()); } catch { /* バナー */ } }, []);
  const loadAll = useCallback(() => { void loadDone(); }, [loadDone]);
  useEffect(() => { loadAll(); }, [loadAll]);
  // 現状は AI が書き換えるので、戻ってきたとき・変更の知らせで読み直す (間隔は長め)
  useAutoRefresh(loadAll, { intervalMs: 60000 });

  const overdue = deadlines.filter((d) => d.daysLeft < 0).length;
  const chips: { key: Key; label: string; count: number; alert?: boolean }[] = [];
  if (deadlines.length) chips.push({ key: "deadlines", label: overdue ? "期限切れ・近い" : "期限が近い", count: deadlines.length, alert: overdue > 0 });
  if (done && done.members.length) chips.push({ key: "done", label: "今日終えた", count: myDoneToday(done, myEmail) });
  if (!chips.length) return null;

  // 開いていた札が0件になったら (全部閉じた等) 何も開かない
  const shown = open && chips.some((c) => c.key === open) ? open : null;
  const tone = shown ? TONE[shown] : null;

  return (
    <div className="mb-6">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="今見ておくもの">
        {chips.map((c) => {
          const t = TONE[c.key];
          const active = shown === c.key;
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="board-summary-panel"
              onClick={() => setOpen((v) => (v === c.key ? null : c.key))}
              title={HINT[c.key]}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-bold cjk transition-colors"
              style={{
                color: c.alert ? "var(--danger)" : t.fg,
                borderColor: active ? (c.alert ? "var(--danger)" : t.fg) : t.border,
                background: active ? t.bg : "var(--surface)",
                boxShadow: active ? `inset 0 0 0 1px ${c.alert ? "var(--danger)" : t.fg}` : undefined,
              }}
            >
              {c.label}
              <span className="tabular-nums font-normal">{c.count}</span>
            </button>
          );
        })}
      </div>
      {shown && tone && (
        <section id="board-summary-panel" role="tabpanel" className="card mt-2 px-4 py-1" style={{ borderColor: tone.border, background: tone.bg }} aria-label={chips.find((c) => c.key === shown)?.label}>
          <p className="pt-2.5 text-[11.5px] cjk" style={{ color: "var(--muted)" }}>{HINT[shown]}</p>
          {shown === "deadlines" && <DeadlineList items={deadlines} />}
          {shown === "done" && done && <DoneCountsBody data={done} myEmail={myEmail} />}
        </section>
      )}
    </div>
  );
}

function DeadlineList({ items }: { items: DeadlineItem[] }) {
  const router = useRouter();
  return (
    <div className="divide-y divide-[var(--border)]">
      {items.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => router.push(`/goals/${g.id}`)}
          onMouseEnter={() => prefetchGoalBundle(g.id)}
          className="flex items-center gap-2 w-full text-left py-2.5 hover:bg-[var(--hover)]"
        >
          {g.emoji && <span className="shrink-0">{g.emoji}</span>}
          <span className="flex-1 min-w-0 break-words text-[14px] cjk text-[var(--foreground)]">{g.name || "（無題）"}</span>
          <span
            className="shrink-0 text-[12.5px] font-medium"
            style={{ color: g.daysLeft < 0 ? "#dc2626" : g.daysLeft <= 2 ? "#d97706" : "var(--muted)" }}
          >
            {g.daysLeft < 0 ? `期限切れ ${Math.abs(g.daysLeft)}日` : g.daysLeft === 0 ? "今日まで" : `あと${g.daysLeft}日`}
          </span>
        </button>
      ))}
    </div>
  );
}
