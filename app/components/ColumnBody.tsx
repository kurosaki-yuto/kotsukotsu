import type * as React from "react";

// コラム本文 (app/lib/columns.ts) の簡易 markdown を描く。設定の連携ガイドと公開ページ /column の両方で使う。
// 対応: ## / ### 見出し、- 箇条書き、1. 番号付き、``` コードブロック、> 引用、**太字**、`コード`、[文字](URL)、空行で段落。
// 画像は1行で ![説明](/path.png)。説明は画像の下に出る。スマホ用を分けるときは ![説明](/wide.svg|/tall.svg)。
// 原稿は自分たちで書くものだけなので、HTML はそのまま文字として出す (dangerouslySetInnerHTML は使わない)。

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k} className="col-code">{m[2]}</code>);
    else {
      const href = m[4];
      const external = /^https?:\/\//.test(href);
      out.push(
        <a key={k} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="col-link">
          {m[3]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// 画像1枚 + 説明。mobileSrc があれば 640px 未満ではそちらを出す (横長の図は縦長版に差し替える)
export function Figure({ src, alt, mobileSrc }: { src: string; alt: string; mobileSrc?: string }) {
  return (
    <figure className="col-figure">
      <picture>
        {mobileSrc && <source media="(max-width: 639px)" srcSet={mobileSrc} />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* スクショ (png) は Retina で撮った2倍の大きさなので、2x として半分の大きさで出す */}
        <img src={src} srcSet={src.endsWith(".png") ? `${src} 2x` : undefined} alt={alt} loading="lazy" />
      </picture>
      {alt && <figcaption>{alt}</figcaption>}
    </figure>
  );
}

export default function ColumnBody({ body }: { body: string }) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key} className="col-pre">{code.join("\n")}</pre>);
      continue;
    }
    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      const [wide, tall] = img[2].split("|");
      blocks.push(<Figure key={key} alt={img[1]} src={wide} mobileSrc={tall} />);
      i++;
      continue;
    }
    if (line.startsWith("### ")) { blocks.push(<h3 key={key} className="col-h3">{inline(line.slice(4), key)}</h3>); i++; continue; }
    if (line.startsWith("## ")) { blocks.push(<h2 key={key} className="col-h2">{inline(line.slice(3), key)}</h2>); i++; continue; }
    if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
      blocks.push(<ul key={key} className="col-ul">{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ""));
      blocks.push(<ol key={key} className="col-ol">{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (line.startsWith("> ")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) q.push(lines[i++].slice(2));
      blocks.push(<blockquote key={key} className="col-quote">{inline(q.join(" "), key)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{2,3} |- |\d+\. |> |```|!\[)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key} className="col-p">{inline(para.join(""), key)}</p>);
  }
  return <div className="col-body">{blocks}</div>;
}
