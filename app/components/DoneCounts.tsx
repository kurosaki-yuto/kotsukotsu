"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DoneCounts as Data } from "../lib/addness";

// 「終えたタスク」の中身。メンバー全員の今日・今週 (月曜から) の完了数 (/api/done-counts)。
// 数はメンバー全員が全員分見られる。タスク名は自分の分だけ (担当外のタスクの中身は見せない)。
// 読み込みと開け閉めは BoardSummary が持つ。
export function myDoneToday(data: Data, myEmail: string | null): number {
  const me = (myEmail ?? "").toLowerCase();
  return data.members.find((m) => m.email === me)?.today ?? 0;
}

export function DoneCountsBody({ data, myEmail }: { data: Data; myEmail: string | null }) {
  const router = useRouter();
  const [range, setRange] = useState<"today" | "week">("today");
  const [showMine, setShowMine] = useState(false);

  const me = (myEmail ?? "").toLowerCase();
  const list = [...data.members].sort((a, b) => b[range] - a[range] || a.name.localeCompare(b.name, "ja"));
  const total = list.reduce((s, m) => s + m[range], 0);
  const myCount = list.find((m) => m.email === me)?.[range] ?? 0;
  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="tab-seg" role="tablist">
          <button type="button" role="tab" aria-selected={range === "today"} className={range === "today" ? "active" : ""} onClick={() => setRange("today")}>今日</button>
          <button type="button" role="tab" aria-selected={range === "week"} className={range === "week" ? "active" : ""} onClick={() => setRange("week")}>今週</button>
        </div>
        <span className="text-[12px]" style={{ color: "var(--muted)" }}>
          あなた <b style={{ color: "var(--done-strong)" }}>{myCount}</b> ・ 全員 {total}
        </span>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-2">
        {list.map((m) => {
          const mine = m.email === me;
          return (
            <li
              key={m.email}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]"
              style={{
                borderColor: mine ? "var(--done-border)" : "var(--border)",
                background: mine ? "var(--done-soft)" : "#fff",
                color: m[range] ? "var(--foreground)" : "var(--muted)",
              }}
            >
              <span className="max-w-[9em] truncate">{m.name}</span>
              <span className="font-bold tabular-nums" style={{ color: m[range] ? "var(--done-strong)" : "var(--muted-soft)" }}>{m[range]}</span>
            </li>
          );
        })}
      </ul>
      {data.mineToday.length > 0 && (
        <div className="mt-2.5">
          <button type="button" onClick={() => setShowMine((v) => !v)} className="text-[12px] font-bold" style={{ color: "var(--done-strong)" }}>
            {showMine ? "閉じる" : `自分が今日終えたもの (${data.mineToday.length})`}
          </button>
          {showMine && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {data.mineToday.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => router.push(`/goals/${t.id}`)} className="block w-full truncate text-left text-[12.5px] hover:underline" style={{ color: "var(--foreground-soft)" }}>
                    ✓ {t.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
        完了にした人の数 (AI が閉じたものは、その AI を使っている人)。10/5 より前の分は担当者で数え、親と一緒に閉じた小タスクは数えない。
      </p>
    </div>
  );
}
