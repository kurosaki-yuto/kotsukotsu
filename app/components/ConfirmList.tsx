"use client";

import { useState } from "react";
import Link from "next/link";
import { answerConfirmation, type Confirmation } from "../lib/addness";

// 完了の基準・現状の「これでいい？ はい / いいえ」(黒崎判断 2026-11-02)。
// 変更前と変更後を行ごとに並べ、消えた行は赤、増えた行は緑で出す。
// 完了の基準の書き換えは「はい」で反映、現状と新しい基準はもう反映済みで「いいえ」なら元に戻る。
const LABEL: Record<string, string> = { completion_criteria: "完了の基準", current_state: "現状" };

// 行ごとの差分 (最長共通部分列)。消えた行は元の位置に、増えた行は新しい位置に出す。文は数十行なので素直な表で足りる
function lineDiff(before: string | null, after: string): { kind: "same" | "add" | "del"; text: string }[] {
  const b = (before ?? "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const a = after.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const dp: number[][] = Array.from({ length: b.length + 1 }, () => new Array<number>(a.length + 1).fill(0));
  for (let i = b.length - 1; i >= 0; i--) for (let j = a.length - 1; j >= 0; j--) dp[i][j] = b[i] === a[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { kind: "same" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) { out.push({ kind: "same", text: a[j] }); i++; j++; }
    else if (j < a.length && (i >= b.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ kind: "add", text: a[j] }); j++; }
    else { out.push({ kind: "del", text: b[i] }); i++; }
  }
  return out;
}

export function ConfirmList({ items, reload, showGoal = true }: { items: Confirmation[]; reload: () => Promise<void> | void; showGoal?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [noFor, setNoFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const answer = async (id: string, yes: boolean) => {
    setBusy(id);
    setError(null);
    try {
      await answerConfirmation(id, yes, yes ? undefined : note);
      setNoFor(null);
      setNote("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "答えられませんでした");
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="divide-y divide-[var(--border)]">
      {items.map((c) => (
        <li key={c.id} className="py-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {showGoal && (
              <Link href={`/goals/${c.goal_id}`} className="min-w-0 break-words text-[14px] font-semibold hover:underline" style={{ color: "var(--foreground)" }}>
                {c.goal_name || "(無題)"}
              </Link>
            )}
            <span className="text-[12px] font-bold" style={{ color: "var(--accent)" }}>
              {LABEL[c.field]}を{c.applied ? (c.before_text ? "書き換えました" : "書きました") : "こう変えます"}
            </span>
            <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>{c.requested_by_name ?? "AI"} · {new Date(c.created_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          {c.reason && <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>{c.reason}</div>}
          <div className="mt-1.5 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            {lineDiff(c.before_text, c.after_text).map((d, i) => (
              <div key={i} className="whitespace-pre-wrap break-words"
                style={d.kind === "add" ? { color: "var(--done-strong)", background: "var(--done-soft)" } : d.kind === "del" ? { color: "var(--danger)", textDecoration: "line-through", opacity: 0.8 } : { color: "var(--foreground-soft)" }}>
                {d.kind === "add" ? "+ " : d.kind === "del" ? "− " : "  "}{d.text}
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-bold">これでいい？</span>
            <button type="button" className="chip chip-done-on" disabled={busy === c.id} onClick={() => void answer(c.id, true)}>はい</button>
            <button type="button" className="chip" disabled={busy === c.id} onClick={() => { setNoFor(noFor === c.id ? null : c.id); setNote(""); }}>いいえ</button>
          </div>
          {noFor === c.id && (
            <div className="mt-2 flex flex-col gap-2">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="どこが違うか (AI がこれを読んで書き直します)"
                className="w-full rounded-lg border px-3 py-2 text-[13px]" style={{ borderColor: "var(--border)", background: "var(--hover)" }} />
              <div>
                <button type="button" className="chip" style={{ color: "var(--danger)" }} disabled={busy === c.id} onClick={() => void answer(c.id, false)}>
                  {c.applied ? "元に戻して書き直してもらう" : "反映せずに書き直してもらう"}
                </button>
              </div>
            </div>
          )}
        </li>
      ))}
      {error && <li className="py-2 text-[12.5px]" style={{ color: "var(--danger)" }}>{error}</li>}
    </ul>
  );
}
