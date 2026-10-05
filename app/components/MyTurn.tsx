"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMyTurn, type MyTurnItem } from "../lib/addness";
import { useAutoRefresh } from "../lib/useAutoRefresh";

// タスク画面の一番上の「あなたの番」。AI が現状に書いた「ボール: ◯◯」に自分の名前があるタスク
// (lib/ball.ts・/api/my-turn)。現状の欄に埋もれていた「自分の返事・判断・作業待ち」を開かずに見せる。
// 0件なら何も出さない。読み込みに失敗したら api() が上部のバナーで知らせる (空と区別するため)。
const FIRST = 5;

function deadlineLabel(d: string | null): string | null {
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.slice(0, 10) + "T00:00:00").getTime() - today.getTime()) / 86400000);
  if (Number.isNaN(days)) return null;
  return days < 0 ? `期限切れ ${-days}日` : days === 0 ? "今日まで" : `あと${days}日`;
}

export default function MyTurn() {
  const router = useRouter();
  const [items, setItems] = useState<MyTurnItem[] | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await getMyTurn()); } catch { /* api() がバナーを出す。前の表示は残す */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // 現状は AI が書き換えるので、ほかの一覧と同じく戻ってきたとき・変更の知らせで読み直す (間隔は長め)
  useAutoRefresh(() => { void load(); }, { intervalMs: 60000 });

  if (!items || items.length === 0) return null;
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <section className="card mb-6 px-4 py-1" style={{ borderColor: "var(--doing-border)", background: "var(--doing-soft)" }} aria-label="あなたの番">
      <div className="flex items-center gap-1.5 py-2.5 text-[13px] font-bold cjk" style={{ color: "var(--doing)" }}>
        あなたの番
        <span className="font-normal">{items.length}</span>
        <span className="ml-1 text-[11.5px] font-normal" style={{ color: "var(--muted)" }}>現状の「ボール」にあなたの名前があるタスク</span>
      </div>
      <ul className="divide-y" style={{ borderColor: "var(--doing-border)" }}>
        {shown.map((t) => {
          const dl = deadlineLabel(t.deadline);
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => router.push(`/goals/${t.id}`)}
                className="block w-full py-2.5 text-left hover:opacity-80"
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" style={{ color: "var(--foreground)" }}>{t.name}</span>
                  {dl && (
                    <span className="flex-none text-[11.5px] font-bold" style={{ color: dl.startsWith("期限切れ") || dl === "今日まで" ? "var(--danger)" : "var(--muted)" }}>{dl}</span>
                  )}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
                  ボール: {t.ball}
                </div>
                {t.parent_name && <div className="mt-0.5 truncate text-[11.5px]" style={{ color: "var(--muted)" }}>{t.parent_name}</div>}
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > FIRST && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full py-2 text-[12.5px] font-bold" style={{ color: "var(--doing)" }}>
          {all ? "少なく表示" : `すべて表示 (${items.length})`}
        </button>
      )}
    </section>
  );
}
