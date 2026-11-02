"use client";

import { useCallback, useEffect, useState } from "react";
import { getGoalConfirmations, type Confirmation } from "../../lib/addness";
import { ConfirmList } from "../ConfirmList";

// ゴールの画面の「これでいい？」。このゴールの完了の基準・現状を AI が書き換えて、まだ答えていないもの。
export function GoalConfirmations({ goalId, onAnswered }: { goalId: string; onAnswered?: () => void }) {
  const [items, setItems] = useState<Confirmation[] | null>(null);
  const load = useCallback(async () => {
    try { setItems(await getGoalConfirmations(goalId)); } catch { /* api() がバナーを出す */ }
  }, [goalId]);
  useEffect(() => { void load(); }, [load]);
  if (!items || items.length === 0) return null;
  return (
    <section className="mt-5 rounded-2xl border px-5 py-2" style={{ borderColor: "var(--accent)", borderLeft: "4px solid var(--accent)" }} aria-label="これでいい？">
      <h3 className="pt-2 text-[14px] font-bold">AI が完了の基準・現状を書き換えました</h3>
      <ConfirmList items={items} showGoal={false} reload={async () => { await load(); onAnswered?.(); }} />
    </section>
  );
}
