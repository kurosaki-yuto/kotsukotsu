"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getGoal } from "../lib/addness";

// 左レールから Claude / Codex のデスクトップアプリを、いま開いているゴールの指示文入りで開く。
// 送信は本人 (アプリ側で Enter)。サービスページの「アプリで開く」と同じ URL を使う。
//   Claude: claude://code/new?q=...          (Claude Desktop の Code 画面)
//   Codex:  codex://threads/new?prompt=...   (Codex アプリ)
// claude.ai/code・chatgpt.com/codex は X-Frame-Options: SAMEORIGIN で埋め込めないため、別アプリで開く形にしている。

function goalIdOf(pathname: string): string | null {
  const m = pathname.match(/^\/goals\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function promptFor(id: string | null, name: string | undefined): string {
  if (id) {
    return [
      `こつこつのゴール${name ? `「${name}」` : ""} (id: ${id}) を進めてください。`,
      "まずこつこつの get_goal・list_subtasks・list_comments で完了の基準と現状、最新のコメントを確認してください。",
      "そのうえで作業ステップを add_subtask で登録してから着手し、1つ終わるごとに complete_subtask してください。",
    ].join("\n");
  }
  return [
    "こつこつの今日のタスクを進めてください。",
    "まずこつこつの list_today と list_goals で今日やるものと期限の近いものを確認し、優先順位を付けて提案してください。",
  ].join("\n");
}

const APPS = [
  { key: "claude", label: "Claude", mark: "C", title: "Claude Code で開く", url: (q: string) => `claude://code/new?q=${q}` },
  { key: "codex", label: "Codex", mark: "›_", title: "Codex で開く", url: (q: string) => `codex://threads/new?prompt=${q}` },
] as const;

export default function AgentLaunch() {
  const id = goalIdOf(usePathname() || "/");
  // ゴール名は指示文を読む人向け。取れなくても id だけで AI は get_goal で辿れる。
  const [name, setName] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    getGoal(id).then((g) => { if (alive && g) setName({ id, name: g.name }); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);
  const text = promptFor(id, name?.id === id ? name.name : undefined);
  const q = encodeURIComponent(text);
  return (
    <div className="w-full mt-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.12)" }}>
      <div className="text-[9px] leading-tight text-center mb-1.5" style={{ color: "var(--sidebar-fg)", opacity: 0.55 }}>
        AIで<br />進める
      </div>
      {APPS.map((a) => (
        <a
          key={a.key}
          href={a.url(q)}
          className="rail-item"
          title={`${a.title} (指示文を入れた状態で開きます。コピーもします)`}
          onClick={() => { try { navigator.clipboard.writeText(text); } catch {} }}
        >
          <span
            className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold"
            style={{ background: "rgba(255,255,255,0.10)" }}
          >
            {a.mark}
          </span>
          <span>{a.label}</span>
        </a>
      ))}
    </div>
  );
}
