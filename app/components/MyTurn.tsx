"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MyTurnItem } from "../lib/addness";

// 「あなたの番」の中身。AI が現状に書いた「ボール: ◯◯」に自分の名前があるタスク (lib/ball.ts・/api/my-turn)。
// 読み込みと開け閉めは BoardSummary (タスク画面の上の札) が持つ。ここは札を押したときに出す一覧だけ。
const FIRST = 5;
const FIRST_PHONE = 3;

function deadlineLabel(d: string | null): string | null {
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.slice(0, 10) + "T00:00:00").getTime() - today.getTime()) / 86400000);
  if (Number.isNaN(days)) return null;
  return days < 0 ? `期限切れ ${-days}日` : days === 0 ? "今日まで" : `あと${days}日`;
}

// 現状が書かれてから何日たったか = 何日待たせているか。3日以上だけ出す (11/1 本番: 黒崎の番44件のうち42件が7日以上)
function waitingLabel(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return Number.isNaN(days) || days < 3 ? null : `${days}日待ち`;
}

export function MyTurnList({ items }: { items: MyTurnItem[] }) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <>
      <ul className="divide-y divide-[var(--doing-border)]">
        {shown.map((t, i) => {
          const dl = deadlineLabel(t.deadline);
          const wait = waitingLabel(t.state_updated_at);
          return (
            // スマホは画面が狭いので3件まで (4・5件目は「すべて表示」で出す)
            <li key={t.id} className={!all && i >= FIRST_PHONE ? "hidden md:block" : undefined}>
              <button
                type="button"
                onClick={() => router.push(`/goals/${t.id}`)}
                className="block w-full py-2.5 text-left hover:opacity-80"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 break-words text-[14px] font-semibold" style={{ color: "var(--foreground)" }}>{t.name}</span>
                  {dl && (
                    <span className="flex-none text-[11.5px] font-bold" style={{ color: dl.startsWith("期限切れ") || dl === "今日まで" ? "var(--danger)" : "var(--muted)" }}>{dl}</span>
                  )}
                  {!dl && wait && <span className="flex-none text-[11.5px]" style={{ color: "var(--muted)" }}>{wait}</span>}
                </div>
                <div className="mt-0.5 line-clamp-1 md:line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
                  ボール: {t.ball}
                </div>
                {t.parent_name && <div className="mt-0.5 hidden md:block truncate text-[11.5px]" style={{ color: "var(--muted)" }}>{t.parent_name}</div>}
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > FIRST_PHONE && (
        <button type="button" onClick={() => setAll((v) => !v)} className={`w-full py-2 text-[12.5px] font-bold ${items.length <= FIRST ? "md:hidden" : ""}`} style={{ color: "var(--doing)" }}>
          {all ? "少なく表示" : `すべて表示 (${items.length})`}
        </button>
      )}
    </>
  );
}
