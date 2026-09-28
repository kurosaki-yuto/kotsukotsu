"use client";

// Auto-links bare URLs inside plain text (comment/chat bodies). Trailing
// punctuation (including common Japanese closers like 」/。) is kept outside
// the link so "参照: https://x.com。" doesn't swallow the 。 into the href.
const URL_RE = /(https?:\/\/[^\s]+)/g;
const TRAILING_PUNCT = /[.,;:!?、。」』】)\]}]+$/;

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Highlights @name mentions within one non-URL text segment. mentionNames
// comes from the goal's current assignees — longest name first so a shorter
// name doesn't shadow-match inside a longer one.
function renderMentions(text: string, mentionNames: string[], keyPrefix: string) {
  if (!mentionNames.length) return text;
  const re = new RegExp(`(@(?:${[...mentionNames].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")}))`, "g");
  const segs = text.split(re);
  if (segs.length === 1) return text;
  return segs.map((seg, i) =>
    i % 2 === 1
      ? <span key={`${keyPrefix}-m${i}`} className="font-semibold" style={{ color: "var(--accent)" }}>{seg}</span>
      : <span key={`${keyPrefix}-t${i}`}>{seg}</span>
  );
}

// linkColor: override for bubbles where the default accent color would clash
// (e.g. white text on an accent-colored background). mentionNames: goal
// assignee names to highlight when prefixed with @ (omit to skip highlighting).
export default function Linkified({ text, linkColor = "var(--accent)", mentionNames = [] }: { text: string; linkColor?: string; mentionNames?: string[] }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <span key={i}>{renderMentions(part, mentionNames, `p${i}`)}</span>;
        const trailing = part.match(TRAILING_PUNCT)?.[0] ?? "";
        const url = trailing ? part.slice(0, part.length - trailing.length) : part;
        return (
          <span key={i}>
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: linkColor }}>
              {url}
            </a>
            {trailing}
          </span>
        );
      })}
    </>
  );
}
