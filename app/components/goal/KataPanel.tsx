"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getGoalKata, fileHref } from "../../lib/addness";
import type { Template } from "../../lib/db";

// 「この仕事の型」。ゴールか祖先が型から作られていれば、型の資料と注意点を出す。
// 本文は持たない (外の資料へのリンクと注意点だけ)。docs/plans/2026-10-14_型をナレッジの入口にする.md
export function KataPanel({ goalId }: { goalId: string }) {
  const [tpl, setTpl] = useState<Template | null>(null);
  useEffect(() => {
    let alive = true;
    // 失敗は api() が読み込み失敗のバナーに出す。ここでは型が無いのと同じく何も描かない
    getGoalKata(goalId).then((t) => { if (alive) setTpl(t); }).catch(() => { if (alive) setTpl(null); });
    return () => { alive = false; };
  }, [goalId]);
  if (!tpl || (!tpl.resources.length && !tpl.cautions.length)) return null;
  return (
    <section className="mt-5 rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)", borderLeft: "4px solid var(--accent)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[14px] font-bold">この仕事の型: {tpl.name}</h3>
        <Link href={`/templates/${tpl.id}`} className="chip">型を開く</Link>
      </div>
      {tpl.cautions.length > 0 && (
        <>
          <div className="mt-3 text-[11px] font-bold tracking-wide" style={{ color: "var(--muted)" }}>注意点</div>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-relaxed">
            {tpl.cautions.map((c, i) => <li key={i} className="break-words">{c.text}</li>)}
          </ul>
        </>
      )}
      {tpl.resources.length > 0 && (
        <>
          <div className="mt-3 text-[11px] font-bold tracking-wide" style={{ color: "var(--muted)" }}>資料</div>
          <ul className="mt-1 flex flex-col gap-1.5">
            {tpl.resources.map((r, i) => (
              <li key={i} className="text-[13px] leading-snug">
                <span className="mr-2 rounded px-1.5 py-0.5 text-[11px]" style={{ background: "var(--hover)" }}>{r.kind}</span>
                <a href={fileHref(r.url)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-all" style={{ color: "var(--accent)" }}>{r.name}</a>
                {r.why && <span className="ml-2 text-[12px]" style={{ color: "var(--muted)" }}>{r.why}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
