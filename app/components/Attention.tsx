"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAttention, dismissAttention, toggleItemDone, type ClosableItem, type StalledItem } from "../lib/addness";
import { useAutoRefresh } from "../lib/useAutoRefresh";
import { Chevron, useCollapsed } from "../lib/useCollapsed";

// タスク画面の「止まっている」と「閉じていい？」(2026-11-01)。
// 止まっている: 進行中のまま24時間動かず、印を外したタスク (lib/stall.ts)。誰がいつ始めてどこで止まったかを出す。
// 閉じていい？: 現状に「照合 PASS」「作業は済み」と書いてある・手順が全部済んだ・配下が全部終わったのに開いたままのタスク。
//   「閉じる」で完了、「まだ」で現状が書き換わるまで出さない。
// どちらも0件なら何も出さない。読み込みに失敗したら api() が上部のバナーで知らせる (空と区別するため)。
const FIRST = 5;
const FIRST_PHONE = 3;

function ago(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (Number.isNaN(days)) return "";
  return days <= 0 ? "今日" : `${days}日前`;
}

export default function Attention() {
  const [data, setData] = useState<{ closable: ClosableItem[]; stalled: StalledItem[] } | null>(null);
  const load = useCallback(async () => {
    try { setData(await getAttention()); } catch { /* api() がバナーを出す。前の表示は残す */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => { void load(); }, { intervalMs: 60000 });
  if (!data) return null;
  return (
    <>
      <Stalled items={data.stalled} reload={load} />
      <Closable items={data.closable} reload={load} />
    </>
  );
}

function Section({ id, title, hint, count, color, children, more }: {
  id: string; title: string; hint: string; count: number; color: { fg: string; border: string; bg: string };
  children: React.ReactNode; more?: React.ReactNode;
}) {
  const [closed, toggle] = useCollapsed(id);
  return (
    <section className="card mb-6 px-4 py-1" style={{ borderColor: color.border, background: color.bg }} aria-label={title}>
      <button type="button" onClick={toggle} aria-expanded={!closed} className="flex w-full items-center gap-1.5 py-2.5 text-left text-[13px] font-bold cjk" style={{ color: color.fg }}>
        <Chevron closed={closed} />
        {title}
        <span className="font-normal">{count}</span>
        <span className="ml-1 hidden md:inline text-[11.5px] font-normal" style={{ color: "var(--muted)" }}>{hint}</span>
      </button>
      {!closed && (<>{children}{more}</>)}
    </section>
  );
}

function Stalled({ items, reload }: { items: StalledItem[]; reload: () => Promise<void> }) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, FIRST);
  const ack = async (id: string) => {
    setBusy(id);
    try { await dismissAttention(id, "ack_stall"); await reload(); } catch { /* バナー */ } finally { setBusy(null); }
  };
  return (
    <Section id="stalled" title="止まっている" hint="進行中のまま24時間動かなかったタスク。開いて続けるか、確認したら消す" count={items.length}
      color={{ fg: "var(--danger)", border: "var(--border-strong)", bg: "var(--surface)" }}
      more={items.length > FIRST_PHONE && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full py-2 text-[12.5px] font-bold" style={{ color: "var(--danger)" }}>
          {all ? "少なく表示" : `すべて表示 (${items.length})`}
        </button>
      )}>
      <ul className="divide-y divide-[var(--border)]">
        {shown.map((t, i) => (
          <li key={t.id} className={`flex items-start gap-3 py-2.5 ${!all && i >= FIRST_PHONE ? "hidden md:flex" : ""}`}>
            <button type="button" onClick={() => router.push(`/goals/${t.id}`)} className="min-w-0 flex-1 text-left hover:opacity-80">
              <div className="break-words text-[14px] font-semibold" style={{ color: "var(--foreground)" }}>{t.name}</div>
              <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{t.stalled_note}</div>
              {t.parent_name && <div className="mt-0.5 hidden md:block truncate text-[11.5px]" style={{ color: "var(--muted)" }}>{t.parent_name}</div>}
            </button>
            <button type="button" onClick={() => void ack(t.id)} disabled={busy === t.id} className="chip shrink-0 mt-0.5" title="止まっている印を消す (タスクはそのまま)">確認した</button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Closable({ items, reload }: { items: ClosableItem[]; reload: () => Promise<void> }) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, FIRST);
  const act = async (id: string, close: boolean) => {
    setBusy(id);
    try {
      if (close) await toggleItemDone(id, true);
      else await dismissAttention(id, "keep_open");
      await reload();
    } catch { /* バナー */ } finally { setBusy(null); }
  };
  return (
    <Section id="closable" title="閉じていい？" hint="終わったと書いてある・手順や配下が全部済んだのに開いたままのタスク" count={items.length}
      color={{ fg: "var(--done-strong)", border: "var(--done-border)", bg: "var(--done-soft)" }}
      more={items.length > FIRST_PHONE && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full py-2 text-[12.5px] font-bold" style={{ color: "var(--done-strong)" }}>
          {all ? "少なく表示" : `すべて表示 (${items.length})`}
        </button>
      )}>
      <ul className="divide-y divide-[var(--done-border)]">
        {shown.map((t, i) => (
          <li key={t.id} className={`flex items-start gap-3 py-2.5 ${!all && i >= FIRST_PHONE ? "hidden md:flex" : ""}`}>
            <button type="button" onClick={() => router.push(`/goals/${t.id}`)} className="min-w-0 flex-1 text-left hover:opacity-80">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 break-words text-[14px] font-semibold" style={{ color: "var(--foreground)" }}>{t.name}</span>
                <span className="flex-none text-[11.5px]" style={{ color: "var(--muted)" }}>{ago(t.state_updated_at)}</span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{t.detail}</div>
              {t.parent_name && <div className="mt-0.5 hidden md:block truncate text-[11.5px]" style={{ color: "var(--muted)" }}>{t.parent_name}</div>}
            </button>
            <div className="flex shrink-0 gap-1.5 mt-0.5">
              <button type="button" onClick={() => void act(t.id, true)} disabled={busy === t.id} className="chip chip-done-on" title="完了にする">閉じる</button>
              <button type="button" onClick={() => void act(t.id, false)} disabled={busy === t.id} className="chip" title="現状が書き換わるまでここに出さない">まだ</button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
