"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getInheritedResources, fileHref } from "../../lib/addness";
import type { InheritedResource } from "../../lib/server/resourcesCore";

// 「上のゴールの資料」。親・その上 (顧客の箱など) に付いた資料を近い順に出す (黒崎判断 2026-11-02)。
// このタスクを見られる人は上の資料も読めるので、リンクを配って権限を付けなくてよい。
export function InheritedResources({ goalId }: { goalId: string }) {
  const [items, setItems] = useState<InheritedResource[] | null>(null);
  useEffect(() => {
    let alive = true;
    // 失敗は api() が読み込み失敗のバナーに出す。前の表示は残す
    getInheritedResources(goalId).then((r) => { if (alive) setItems(r); }).catch(() => {});
    return () => { alive = false; };
  }, [goalId]);
  if (!items || items.length === 0) return null;
  return (
    <section className="mt-5 rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)" }} aria-label="上のゴールの資料">
      <h3 className="text-[14px] font-bold">上のゴールの資料 <span className="text-[12px] font-normal" style={{ color: "var(--muted)" }}>{items.length}</span></h3>
      <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--muted)" }}>このタスクの上のゴールに付いた資料です。このタスクを見られる人は開けます。</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map((r) => (
          <li key={r.id} className="text-[13px] leading-snug">
            <Link href={`/goals/${r.goal_id}`} className="mr-2 rounded px-1.5 py-0.5 text-[11px] hover:underline" style={{ background: "var(--hover)", color: "var(--foreground-soft)" }}>
              {r.goal_name || "(無題)"}
            </Link>
            {r.url ? (
              <a href={fileHref(r.url)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-all" style={{ color: "var(--accent)" }}>{r.name}</a>
            ) : (
              <span className="font-semibold break-words">{r.name}</span>
            )}
            {r.content && <span className="ml-2 text-[12px] break-words" style={{ color: "var(--muted)" }}>{r.content.length > 120 ? `${r.content.slice(0, 120)}…` : r.content}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
