"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getGoalKata, fileHref } from "../../lib/addness";
import type { Template } from "../../lib/db";

const OPEN_KEY = "kk:kata:open";

// 「この仕事の型」。ゴールか祖先が型から作られていれば、型の資料と注意点を出す。
// 本文は持たない (外の資料へのリンクと注意点だけ)。docs/plans/2026-10-14_型をナレッジの入口にする.md
// 注意点が20件を超える型があり、開いたままだとタスク画面が型で埋まるので、1行に閉じておき押すと開く
// (11/3 黒崎「トグルで閉まるように」)。開閉は端末に覚える (全ゴール共通)。
export function KataPanel({ goalId }: { goalId: string }) {
  const [tpl, setTpl] = useState<Template | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(localStorage.getItem(OPEN_KEY) === "1"); } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    let alive = true;
    // 失敗は api() が読み込み失敗のバナーに出す。ここでは型が無いのと同じく何も描かない
    getGoalKata(goalId).then((t) => { if (alive) setTpl(t); }).catch(() => { if (alive) setTpl(null); });
    return () => { alive = false; };
  }, [goalId]);
  if (!tpl || (!tpl.resources.length && !tpl.cautions.length)) return null;
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };
  return (
    <section className="mt-5 rounded-2xl border px-5 py-3" style={{ borderColor: "var(--border)", borderLeft: "4px solid var(--accent)" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-80"
        >
          <span style={{ display: "inline-flex", flex: "none", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} aria-hidden>
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
          </span>
          <h3 className="min-w-0 text-[14px] font-bold break-words">この仕事の型: {tpl.name}</h3>
          <span className="shrink-0 text-[12px] font-normal" style={{ color: "var(--muted)" }}>
            注意点 {tpl.cautions.length} ・ 資料 {tpl.resources.length}
          </span>
        </button>
        <Link href={`/templates/${tpl.id}`} className="chip shrink-0">型を開く</Link>
      </div>
      {open && tpl.cautions.length > 0 && (
        <>
          <div className="mt-3 text-[11px] font-bold tracking-wide" style={{ color: "var(--muted)" }}>注意点</div>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-relaxed">
            {tpl.cautions.map((c, i) => <li key={i} className="break-words">{c.text}</li>)}
          </ul>
        </>
      )}
      {open && tpl.export_url?.startsWith("r2:") && (
        <div className="mt-3 text-[12.5px]">
          <a href={fileHref(tpl.export_url)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: "var(--accent)" }}>
            型の写し (Markdown) を開く
          </a>
          <span className="ml-2 text-[12px]" style={{ color: "var(--muted)" }}>手順・注意点・タスクを1枚にまとめたもの</span>
        </div>
      )}
      {open && tpl.resources.length > 0 && (
        <>
          <div className="mt-3 text-[11px] font-bold tracking-wide" style={{ color: "var(--muted)" }}>資料</div>
          <ul className="mt-1 mb-1 flex flex-col gap-1.5">
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
