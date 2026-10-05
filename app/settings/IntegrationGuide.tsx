"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Figure } from "../components/ColumnBody";
import { COLUMNS } from "../lib/columns";
import { planDayAutoPrompt, planDayPrompt } from "../lib/planDay";
import {
  CONNECTOR_GROUPS,
  STATE_SOURCES,
  checkPrompt,
  claudeCodeSetupPrompt,
  codexSetupPrompt,
  connectorPrompt,
  type Connector,
} from "../lib/integrations";

// 設定の3つ目のタブ「連携ガイド」。
// こつこつ本体は他のツールと繋ぐ機能を持たない。連携は AI の側に入れ、AI が Chatwork やメールを読んで
// こつこつの「現状」に書く。ここはその繋ぎ方と、おすすめの連携先・使い方のコラムを並べるだけの画面。
// ボタンは「AIアプリを指示文入りで開く」+「同じ指示文をコピー」(components/AgentLaunch.tsx と同じやり方)。

// 2026-10-05 確認: 旧 /settings/connectors は「コネクタはカスタマイズに移動しました」になる
const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API が使えない環境 (http・古いブラウザ) の代わり
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

function CopyButton({ text, label = "指示文をコピー" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "ng">("idle");
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return (
    <button
      type="button"
      className="chip flex-none"
      onClick={async () => {
        setState((await copyText(text)) ? "ok" : "ng");
        if (t.current) clearTimeout(t.current);
        t.current = setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "ok" ? "コピー済" : state === "ng" ? "コピーできませんでした" : label}
    </button>
  );
}

// 指示文を入れてアプリを開く。押した時点で同じ指示文もコピーしておく (アプリ側で落ちても貼れば始められる)
function OpenButton({ href, text, label, dark }: { href: string; text: string; label: string; dark?: boolean }) {
  return (
    <a
      href={href}
      target={href.startsWith("http") ? "_blank" : undefined}
      rel={href.startsWith("http") ? "noopener noreferrer" : undefined}
      onClick={() => { void copyText(text); }}
      className={dark ? "btn-dark flex-none text-center" : "chip flex-none"}
    >
      {label}
    </a>
  );
}

const claudeCodeUrl = (text: string) => `claude://code/new?q=${encodeURIComponent(text)}`;
const codexUrl = (text: string) => `codex://threads/new?prompt=${encodeURIComponent(text)}`;
const claudeChatUrl = (text: string) => `https://claude.ai/new?q=${encodeURIComponent(text)}`;

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border p-4 md:p-5" style={{ borderColor: "var(--border)", background: "#fff" }}>
      {children}
    </div>
  );
}

function SectionHead({ title, lead }: { title: string; lead?: string }) {
  return (
    <div className="mb-3.5">
      <h3 className="text-[15px] font-bold" style={{ color: "var(--foreground)" }}>{title}</h3>
      {lead && <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{lead}</p>}
    </div>
  );
}

// `コマンド` の部分だけ等幅で出す
function WithCode({ text }: { text: string }) {
  return <>{text.split(/`([^`]+)`/).map((t, i) => (i % 2 ? <code key={i} className="col-code break-all">{t}</code> : t))}</>;
}

function ConnectorCard({ c }: { c: Connector }) {
  const prompt = connectorPrompt(c);
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-[14.5px] font-bold" style={{ color: "var(--foreground)" }}>{c.name}</div>
        <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{c.provider}</div>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{c.reads}</p>
      <dl className="mt-3 grid gap-x-3 gap-y-1.5 text-[12.5px] leading-relaxed md:grid-cols-[88px_1fr]" style={{ color: "var(--foreground-soft)" }}>
        <dt className="font-bold" style={{ color: "var(--muted)" }}>Claude</dt>
        <dd><WithCode text={c.claude} /></dd>
        <dt className="font-bold" style={{ color: "var(--muted)" }}>Claude Code</dt>
        <dd><WithCode text={c.claudeCode} /></dd>
        <dt className="font-bold" style={{ color: "var(--muted)" }}>Codex</dt>
        <dd><WithCode text={c.codex} /></dd>
      </dl>
      {c.note && <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{c.note}</p>}
      <div className="mt-3.5 flex flex-wrap gap-2">
        {c.claudeConnector && (
          <a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer" className="chip flex-none">
            Claude のコネクタ設定を開く
          </a>
        )}
        {c.setup?.includes("claudeCode") && (
          <span className="hidden md:inline-flex"><OpenButton href={claudeCodeUrl(prompt)} text={prompt} label="Claude Code で繋ぐ" /></span>
        )}
        {c.setup?.includes("codex") && (
          <span className="hidden md:inline-flex"><OpenButton href={codexUrl(prompt)} text={prompt} label="Codex で繋ぐ" /></span>
        )}
        <CopyButton text={prompt} />
        {c.docs && (
          <a href={c.docs} target="_blank" rel="noopener noreferrer" className="chip flex-none">公式の手順</a>
        )}
      </div>
    </Card>
  );
}

export default function IntegrationGuide({ connectUrl, keyUrl, official }: { connectUrl: string; keyUrl: string; official: boolean }) {
  const ccPrompt = claudeCodeSetupPrompt(connectUrl, official);
  const cxPrompt = codexSetupPrompt(keyUrl);
  const chk = checkPrompt();
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <section className="card max-w-[760px] p-4 md:p-6">
      <h2 className="mb-1.5 text-base font-bold">連携ガイド</h2>
      <p className="text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
        こつこつ自体には、Chatwork やメールと繋ぐ機能はありません。連携は AI の側に入れます。
        AI が Chatwork・メール・カレンダーを読み、分かったことをこつこつの「現状」に書きます。
        いま使っているツールを変えずに、AI が読めるタスク一覧を保てます。
      </p>

      {/* ---------- 何がどう繋がるか (図) ---------- */}
      <Figure
        src="/guide/connect-map-wide.svg"
        mobileSrc="/guide/connect-map-tall.svg"
        alt="各ツールを読むのも、こつこつに書くのも AI。こつこつと各ツールは直接は繋がない"
      />

      {/* ---------- 現状の各項目をどこから取るか ---------- */}
      <div className="mt-6">
        <SectionHead
          title="AI が現状を書くときに読むもの"
          lead="こつこつの「現状」は4つの項目で書きます。それぞれの材料がどこにあるかの対応表です。"
        />
        <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: "var(--border)" }}>
          {STATE_SOURCES.map((s, i) => (
            <div
              key={s.item}
              className="grid gap-1 px-4 py-3 md:grid-cols-[150px_1fr] md:gap-4"
              style={{ borderTop: i ? "1px solid var(--border)" : undefined, background: i % 2 ? "#fafafb" : "#fff" }}
            >
              <div className="text-[13px] font-bold" style={{ color: "var(--foreground)" }}>{s.item}</div>
              <div className="text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{s.from}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- 連携する AI ---------- */}
      <div className="mt-8">
        <SectionHead
          title="こつこつと繋ぐ AI"
          lead="まずこつこつ自体を AI に繋ぎます。ボタンを押すと、繋ぐための指示文が入った状態でアプリが開きます。送信は自分で押してください。"
        />
        <div className="flex flex-col gap-3">
          <Card>
            <div className="text-[14.5px] font-bold">Claude（デスクトップ・Web・スマホ）</div>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
              会話しながらタスクを砕く・現状を書くのに向いています。こつこつは「カスタムコネクタ」で追加します（手順は「APIキー」タブ）。
              Gmail・カレンダー・ドライブなどのコネクタも同じ画面で足せます。
            </p>
            <div className="mt-3.5 flex flex-wrap gap-2">
              <a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer" className="btn-dark flex-none text-center">
                Claude のコネクタ設定を開く
              </a>
              <OpenButton href={claudeChatUrl(chk)} text={chk} label="繋がりを確かめる" />
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-[12.5px] font-bold" style={{ color: "var(--accent)" }}>画面で見る手順（3枚）</summary>
              <Figure src="/guide/kotsukotsu-connect-url.png" alt="① こつこつの 設定 → APIキー で接続用URLをコピー (画面は kotukotu.app の場合)" />
              <Figure src="/guide/claude-add-menu.png" alt="② Claude の カスタマイズ → コネクタ → 右上の「追加」→「カスタムコネクタを追加」" />
              <Figure src="/guide/claude-custom-connector.png" alt="③ 名前に「こつこつ」、URL に接続用URLを貼って「続ける」→ こつこつにログイン" />
            </details>
          </Card>
          <Card>
            <div className="text-[14.5px] font-bold">Claude Code</div>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
              フォルダの資料やコードを触りながら進めるのに向いています。ゴール画面の「AIで進める」からも開けます。
            </p>
            <div className="mt-3.5 flex flex-wrap gap-2">
              <span className="hidden md:inline-flex"><OpenButton href={claudeCodeUrl(ccPrompt)} text={ccPrompt} label="Claude Code で繋ぐ" dark /></span>
              <CopyButton text={ccPrompt} />
            </div>
          </Card>
          <Card>
            <div className="text-[14.5px] font-bold">Codex</div>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
              ChatGPT のアカウントで使う OpenAI のエージェントです。Claude Code と同じく、フォルダを触る作業に向いています。
            </p>
            <div className="mt-3.5 flex flex-wrap gap-2">
              <span className="hidden md:inline-flex"><OpenButton href={codexUrl(cxPrompt)} text={cxPrompt} label="Codex で繋ぐ" dark /></span>
              <CopyButton text={cxPrompt} />
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              指示文にはあなた専用のキー入りURLが入ります。人に共有しないでください。
            </p>
          </Card>
        </div>
      </div>

      {/* ---------- おすすめ連携 ---------- */}
      <div className="mt-8">
        <SectionHead
          title="AI に繋いでおくとよいもの"
          lead="こつこつではなく、AI の側に繋ぎます。繋いでおくと、AI が現状を書くときに先方の最後の発言や予定まで読めます。"
        />
        <div className="mb-3">
          <OpenButton href={claudeChatUrl(chk)} text={chk} label="今どれが繋がっているか AI に確かめる" />
        </div>
        <div className="mb-5">
          <Figure src="/guide/claude-connectors.png" alt="Claude の カスタマイズ → コネクタ。Gmail・Google Calendar・Google Drive・Notion などはここから追加し、繋がると緑のチェックが付く" />
        </div>
        <div className="flex flex-col gap-6">
          {CONNECTOR_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="mb-2 text-[12.5px] font-bold" style={{ color: "var(--muted)" }}>{g.title}</div>
              <div className="flex flex-col gap-3">
                {g.items.map((c) => <ConnectorCard key={c.name} c={c} />)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- おすすめの使い方 ---------- */}
      <div className="mt-8">
        <SectionHead
          title="おすすめの使い方"
          lead="こつこつと Google カレンダーを繋いだ AI にできることです。ボタンを押すと指示文が入った状態で開きます。"
        />
        <Card>
          <div className="text-[14.5px] font-bold">AI に今日の予定を組ませる</div>
          <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
            今日やるタスク・期限が近いタスク・進行中のタスクを AI が選び、かかる時間を見積もって、Google カレンダーの空き時間に「[こつこつ] タスク名」の予定を入れます。
            既存の予定は動かしません。タスク画面の「AIで今日の予定を組む」からも開けます。
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            <OpenButton href={claudeChatUrl(planDayPrompt(origin))} text={planDayPrompt(origin)} label="Claude で組む" dark />
            <CopyButton text={planDayPrompt(origin)} />
          </div>
          <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--border)" }}>
            <div className="text-[13px] font-bold">メンバーの分をまとめて組む</div>
            <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
              タスク画面の「AIで今日の予定を組む」→「メンバーの予定を組む」に名前を読点で区切って入れます (例: 田中、松本)。
              AI がメンバーごとにタスクを取り、各自のカレンダーの空きに並べた案を出します。
              予定を書き込めるのは、Google カレンダーの共有で「予定の変更権限」をあなたに付けているメンバーだけです。それ以外の人は案だけ出し、招待は送りません。
            </p>
          </div>
          <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--border)" }}>
            <div className="text-[13px] font-bold">毎朝自動で組ませる</div>
            <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
              Claude の「スケジュール済みタスク」→「新規タスク」→「手動で設定」で、手順に下の指示文を貼り、頻度を「平日」と時刻にします。
              自動版は確認を待たずに予定を入れます (既存の予定は触りません)。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton text={planDayAutoPrompt(origin)} label="自動版の指示文をコピー" />
              <a href="https://claude.ai/scheduled-task" target="_blank" rel="noopener noreferrer" className="chip flex-none">スケジュール済みタスクを開く</a>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-[12.5px] font-bold" style={{ color: "var(--accent)" }}>画面で見る手順（2枚）</summary>
              <Figure src="/guide/claude-schedule-menu.png" alt="① スケジュール済みタスク → 右上の「新規タスク」→「手動で設定」" />
              <Figure src="/guide/claude-schedule-form.png" alt="② 名前と手順 (自動版の指示文) を入れ、頻度を「平日」と時刻にして保存" />
            </details>
          </div>
        </Card>
      </div>

      {/* ---------- コラム ---------- */}
      <div className="mt-8">
        <SectionHead title="使い方のコラム" lead="繋ぎ方とおすすめのやり方を記事にしています。" />
        <div className="flex flex-col gap-3">
          {COLUMNS.map((c) => (
            // 設定画面を離れずに読めるよう、別ウィンドウで公開ページを開く
            <a
              key={c.slug}
              href={`/column/${c.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // 別ウィンドウ (タブではなく窓) で開く。ポップアップが止められたらリンクどおり新しいタブで開く
                const w = window.open(`/column/${c.slug}`, `column-${c.slug}`, "popup,width=900,height=900");
                if (w) { e.preventDefault(); w.focus(); }
              }}
              className="block rounded-[12px] border p-4 transition-colors hover:bg-[var(--hover)] md:p-5"
              style={{ borderColor: "var(--border)", background: "#fff" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.thumb} alt="" className="mb-3 aspect-[1200/630] w-full rounded-[8px] object-cover" style={{ border: "1px solid var(--border)" }} />
              <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{c.date}</div>
              <div className="mt-0.5 text-[14.5px] font-bold leading-snug" style={{ color: "var(--foreground)" }}>{c.title}</div>
              <div className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{c.summary}</div>
              <div className="mt-2 text-[12px] font-bold" style={{ color: "var(--accent)" }}>別ウィンドウで読む ↗</div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
