"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// タスクの行を押したときの「手応え」(2026-11-03 黒崎)。
// 完了: 押した行はその場で取り消し線になり、少し置いてから滑って消える。すぐ消えると
// 効いたのか・何を消したのかが分からず、残り続けると完了が溜まって読めなくなるため、
// 「見せてから消す」の両取りにしている。
// 開始: 進行中の印が弾んで出て、行が一瞬だけ橙に光る。
// 画面側は fresh に入っている間だけ完了行を出し続け、leaving で消える動きを付ける。
export const DONE_HOLD_MS = 1100; // 取り消し線を見せている時間
export const DONE_LEAVE_MS = 360; // 消える動きの長さ (globals.css の kk-leave と合わせる)
export const START_FLASH_MS = 900;

export function useRowFx() {
  const [fresh, setFresh] = useState<Set<string>>(new Set()); // 今ここで完了にした行 (まだ出している)
  const [leaving, setLeaving] = useState<Set<string>>(new Set()); // 消える動きの最中
  const [started, setStarted] = useState<Set<string>>(new Set()); // 今ここで開始した行
  const timers = useRef<Map<string, number[]>>(new Map());

  const clearTimers = (key: string) => {
    for (const t of timers.current.get(key) ?? []) window.clearTimeout(t);
    timers.current.delete(key);
  };
  const without = (s: Set<string>, id: string) => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; };
  const withId = (s: Set<string>, id: string) => { if (s.has(id)) return s; const n = new Set(s); n.add(id); return n; };

  // 完了のチェックを押した / 外した
  const markDone = useCallback((id: string, done: boolean) => {
    clearTimers(`done:${id}`);
    setLeaving((s) => without(s, id));
    if (!done) { setFresh((s) => without(s, id)); return; }
    setFresh((s) => withId(s, id));
    const t1 = window.setTimeout(() => {
      setLeaving((s) => withId(s, id));
      const t2 = window.setTimeout(() => {
        setFresh((s) => without(s, id));
        setLeaving((s) => without(s, id));
        timers.current.delete(`done:${id}`);
      }, DONE_LEAVE_MS);
      timers.current.set(`done:${id}`, [t2]);
    }, DONE_HOLD_MS);
    timers.current.set(`done:${id}`, [t1]);
  }, []);

  // 開始を押した
  const markStarted = useCallback((id: string, on: boolean) => {
    clearTimers(`start:${id}`);
    if (!on) { setStarted((s) => without(s, id)); return; }
    setStarted((s) => withId(s, id));
    const t = window.setTimeout(() => { setStarted((s) => without(s, id)); timers.current.delete(`start:${id}`); }, START_FLASH_MS);
    timers.current.set(`start:${id}`, [t]);
  }, []);

  useEffect(() => () => { for (const ts of timers.current.values()) for (const t of ts) window.clearTimeout(t); timers.current.clear(); }, []);

  // 行に付けるクラス。keepVisible = その行は完了を出す設定で元から見えている (消す動きは付けない)
  const rowClass = useCallback((id: string, keepVisible = false) => {
    let c = "";
    if (fresh.has(id)) c += " done-fresh";
    if (!keepVisible && leaving.has(id)) c += " done-leave";
    if (started.has(id)) c += " start-fresh";
    return c;
  }, [fresh, leaving, started]);

  return { fresh, markDone, markStarted, rowClass };
}
