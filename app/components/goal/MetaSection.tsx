"use client";

// ゴール詳細の「完了の基準・現状」(既定は閉じている。AI が読む欄)。app/goals/[id]/page.tsx から切り出し。
import type * as React from "react";
import type { Goal } from "../../lib/db";
import AutoGrowTextarea from "../AutoGrowTextarea";
import { I } from "./Icon";

// 完了の基準・現状は AI と人が同じ文章を読んで動くところ。抽象的に書かれると
// 共有した意味が無くなるので、入力欄に良い例と悪い例をそのまま出す。
const CRITERIA_PLACEHOLDER = `× 「LPが良い感じになる」「営業を強化する」
○ 下のように、判定できる形で書く

・サービスLPを公開し、問い合わせフォームの送信をスマホ実機で確認
・9/30までに問い合わせ3件
・成果物: lp/index.html、計測用のGA4イベント設定`;

const STATE_PLACEHOLDER = `× 「進めている」「対応中」
○ 下のように、日付と残りを書く

9/12時点。ヒーローと料金表は実装済み、Vercelにデプロイ済み。
残り: 画像3点の発注、フォームの送信先結線。
詰まり: 先方のロゴデータ待ち（9/10に依頼、返信なし）。`;

export function MetaSection({ goal, showMeta, setShowMeta, patch }: {
  goal: Goal;
  showMeta: boolean;
  setShowMeta: React.Dispatch<React.SetStateAction<boolean>>;
  patch: (p: Partial<Goal>) => Promise<void>;
}) {
  return (
    <div className="mb-4 rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
      <button
        type="button"
        onClick={() => setShowMeta((v) => !v)}
        aria-expanded={showMeta}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[var(--hover)]"
      >
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--muted)] min-w-0">
          <I d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /><span className="whitespace-nowrap">完了の基準・現状</span>
          {!showMeta && (
            <span className="font-normal text-[var(--muted-soft)] truncate hidden sm:inline">
              {goal.completion_criteria?.trim() || goal.current_state?.trim() ? "（AIが読む欄。開いて確認・編集）" : "（未記入）"}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[var(--muted-soft)]" style={{ transform: showMeta ? "rotate(180deg)" : undefined, transition: "transform .15s" }}>
          <I d="M6 9l6 6 6-6" />
        </span>
      </button>
      {showMeta && (
        <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: "var(--border)" }}>
          <div className="text-xs font-semibold mb-1 mt-2" style={{ color: "var(--accent)" }}>完了の基準 — これが満たされたら完了</div>
          <p className="text-[11.5px] text-[var(--muted)] mb-1.5 cjk">
            他人が見て○×を付けられる形で書く。数字・日付・成果物の名前を必ず入れる。
            「検討する」「改善する」「いい感じにする」は基準にならない。
          </p>
          <AutoGrowTextarea
            defaultValue={goal.completion_criteria ?? ""}
            onBlur={(e) => patch({ completion_criteria: e.target.value })}
            placeholder={CRITERIA_PLACEHOLDER}
            minRows={5}
            className="w-full bg-white rounded-lg px-3 py-2 text-[14px] focus:outline-none border"
            style={{ borderColor: "#cdd9ff" }}
          />
          <div className="text-xs font-semibold text-[var(--muted)] mb-1 mt-3">現状 — 今どこまで進んでいるか</div>
          <p className="text-[11.5px] text-[var(--muted)] mb-1.5 cjk">
            日付から書き始めて「済んだこと / 残っていること / 詰まっていること」の3つを出す。
            「進めている」「対応中」だけだと、読んだ人が次の一手を判断できない。
          </p>
          <AutoGrowTextarea defaultValue={goal.current_state ?? ""} onBlur={(e) => patch({ current_state: e.target.value })}
            placeholder={STATE_PLACEHOLDER} minRows={5}
            className="w-full bg-[var(--hover)] rounded-lg px-3 py-2 text-sm focus:outline-none" />
        </div>
      )}
    </div>
  );
}
