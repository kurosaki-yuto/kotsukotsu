"use client";

import { useEffect, useRef, useState } from "react";
import { getMe, listMembers } from "../lib/addness";
import type { Member } from "../lib/db";
import { meetPrompt } from "../lib/planDay";
import { claudeChatUrl } from "../lib/claudeLinks";

// 「日程を合わせる」。参加するメンバー・長さ・探す範囲を選ぶと、全員の Google カレンダーの空きが重なる枠を
// AI に探させる指示文を入れた状態で Claude を開く (送信は本人)。指示文は lib/planDay.ts の meetPrompt。
// こつこつ本体はカレンダーと繋がらない。空きを読むのも予定を作るのも、Claude に繋いだ Google カレンダー。
// タスク詳細から開くときは task と、担当者を最初から選んだ状態にする defaultMemberIds を渡す。

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// 日本時間の YYYY-MM-DD。端末の時刻帯に関係なく日本の日付で範囲を作る
function jstDate(offsetDays = 0): Date {
  const d = new Date(Date.now() + 9 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

type RangeKey = "3days" | "week" | "nextweek";
function rangeOf(key: RangeKey): { from: string; to: string } {
  const today = jstDate();
  if (key === "week") return { from: ymd(today), to: ymd(jstDate(6)) };
  if (key === "nextweek") {
    // 来週の月曜〜金曜
    const dow = today.getUTCDay(); // 0=日
    const toMon = ((8 - dow) % 7) || 7;
    return { from: ymd(jstDate(toMon)), to: ymd(jstDate(toMon + 4)) };
  }
  // 今日を含めて平日3日分
  let n = 0, i = 0, last = today;
  while (n < 3) {
    const d = jstDate(i);
    if (!isWeekend(d)) { n++; last = d; }
    i++;
  }
  return { from: ymd(today), to: ymd(last) };
}

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "3days", label: "今日から平日3日" },
  { key: "week", label: "今日から1週間" },
  { key: "nextweek", label: "来週 (月〜金)" },
];
const LENGTHS = [15, 30, 60, 90];

export default function MeetLaunch({ task, defaultMemberIds, align = "right" }: { task?: { id: string; name: string }; defaultMemberIds?: string[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [minutes, setMinutes] = useState(30);
  const [range, setRange] = useState<RangeKey>("3days");
  const [purpose, setPurpose] = useState("");
  const [online, setOnline] = useState(true);
  const [copied, setCopied] = useState<"idle" | "ok" | "ng">("idle");
  const ref = useRef<HTMLDivElement>(null);
  // 親が再描画するたびに配列が新しくなるので、読み込みのやり直しを起こさないよう ref で持つ
  const defaultsRef = useRef(defaultMemberIds);
  defaultsRef.current = defaultMemberIds;

  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!open) { setCopied("idle"); return; }
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // 開いたときにメンバーを読む。タスク詳細からなら担当者 (自分以外) を選んだ状態にする
  useEffect(() => {
    if (!open || members) return;
    let alive = true;
    // members.is_you は画面を開いている人を表さない (workspace.ts 参照) ので、ログイン中のメールで自分を外す
    Promise.all([listMembers(), getMe()])
      .then(([ms, me]) => {
        if (!alive) return;
        const myEmail = me.user?.email?.toLowerCase() ?? "";
        const others = ms.filter((m) => !m.is_ai && !(myEmail && m.email?.toLowerCase() === myEmail));
        setMembers(others);
        const defaults = defaultsRef.current;
        if (defaults?.length) {
          const ids = new Set(others.map((m) => m.id));
          setPicked(new Set(defaults.filter((id) => ids.has(id))));
        }
      })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [open, members]);

  const people = (members ?? []).filter((m) => picked.has(m.id)).map((m) => ({ name: m.name, email: m.email }));
  const { from, to } = rangeOf(range);
  const text = meetPrompt({ people, minutes, from, to, purpose, online, task: task ?? null }, origin);
  const ready = people.length > 0;

  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const label = "block text-[11.5px] font-bold mb-1";
  const select = "w-full rounded-[8px] border px-2 py-1.5 text-[13px] bg-white outline-none";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="chip"
        title="メンバー全員の Google カレンダーの空きが重なる時間を AI に探させる"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M16 4.5a3 3 0 0 1 0 6M18 14.8c1.8.7 3 2.5 3 5.2" /></svg>
        <span className="hidden md:inline">日程を合わせる</span><span className="md:hidden">日程</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="メンバーと日程を合わせる"
          // スマホはボタンの位置に関係なく画面の左右16pxに合わせる (ボタン基準だと画面からはみ出す)
          className={`fixed left-4 right-4 top-16 max-h-[calc(100dvh-5rem)] overflow-y-auto md:absolute md:top-auto md:max-h-none md:overflow-visible md:w-[320px] ${align === "left" ? "md:left-0 md:right-auto" : "md:left-auto md:right-0"} mt-1 z-30 card p-4`}
          style={{ boxShadow: "var(--shadow-pop)" }}
        >
          <div className="text-sm font-bold">メンバーと日程を合わせる</div>
          <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            全員の Google カレンダーの空きが重なる時間を AI が探して候補を出します。番号を選ぶまで予定は作りません。{task ? "候補をこのタスクのコメントに出して、メンバーに選んでもらうこともできます。" : ""}
          </p>

          <div className="mt-3">
            <span className={label}>参加するメンバー</span>
            {loadError ? (
              <div className="text-[12px]" style={{ color: "var(--danger)" }}>メンバーを読めませんでした。画面を開き直してください</div>
            ) : !members ? (
              <div className="text-[12px]" style={{ color: "var(--muted)" }}>読み込み中…</div>
            ) : members.length === 0 ? (
              <div className="text-[12px]" style={{ color: "var(--muted)" }}>自分以外のメンバーがいません</div>
            ) : (
              <div className="max-h-[168px] overflow-y-auto rounded-[8px] border py-1" style={{ borderColor: "var(--border)" }}>
                {members.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] cursor-pointer hover:bg-[var(--hover)]">
                    <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {!m.email && <span className="text-[10.5px]" style={{ color: "var(--muted-soft)" }}>メール未登録</span>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <span className={label}>長さ</span>
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={select} style={{ borderColor: "var(--border-strong)" }}>
                {LENGTHS.map((n) => <option key={n} value={n}>{n}分</option>)}
              </select>
            </div>
            <div>
              <span className={label}>探す範囲</span>
              <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className={select} style={{ borderColor: "var(--border-strong)" }}>
                {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>{from === to ? from : `${from} 〜 ${to}`} の平日 9:00〜19:00</div>

          <div className="mt-3">
            <span className={label}>用件</span>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder={task ? task.name : "例: 公益社の提案すり合わせ"}
              className="w-full rounded-[8px] border px-2.5 py-1.5 text-[13px] outline-none"
              style={{ borderColor: "var(--border-strong)" }}
            />
          </div>

          <label className="mt-2.5 flex items-center gap-2 text-[12.5px] cursor-pointer">
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
            オンライン (Google Meet を付ける)
          </label>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <a
              href={ready ? claudeChatUrl(text) : undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!ready}
              onClick={(e) => { if (!ready) { e.preventDefault(); return; } void copyText(text); setOpen(false); }}
              className="inline-block rounded-full px-3.5 py-1.5 text-[12.5px] font-bold text-white"
              style={{ background: ready ? "var(--accent)" : "var(--muted-soft)", cursor: ready ? "pointer" : "not-allowed" }}
            >
              Claude で候補を出す
            </a>
            {/* Claude Desktop の Code 画面。PC のみ (スマホでは開けない) */}
            <a
              href={ready ? `claude://code/new?q=${encodeURIComponent(text)}` : undefined}
              aria-disabled={!ready}
              onClick={(e) => { if (!ready) { e.preventDefault(); return; } void copyText(text); setOpen(false); }}
              className="hidden md:inline-block rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold"
              style={{ borderColor: "var(--border-strong)", color: ready ? "var(--foreground)" : "var(--muted-soft)", cursor: ready ? "pointer" : "not-allowed" }}
            >
              Claude Code で
            </a>
            <button
              type="button"
              disabled={!ready}
              onClick={async () => { const ok = await copyText(text); setCopied(ok ? "ok" : "ng"); }}
              className="text-[12px] underline underline-offset-2 disabled:no-underline"
              style={{ color: copied === "ng" ? "var(--danger)" : "var(--muted)" }}
            >
              {copied === "ok" ? "コピーしました" : copied === "ng" ? "コピーできませんでした" : "指示文をコピー"}
            </button>
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
            空きを読めるのは、Google カレンダーをあなたに共有しているメンバーだけです。読めない人は「空き不明」として候補の下に出ます。
          </p>
        </div>
      )}
    </div>
  );
}
