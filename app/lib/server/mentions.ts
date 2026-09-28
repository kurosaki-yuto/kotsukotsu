export type MentionableMember = {
  id: string;
  name: string;
  email: string | null;
};

// Registered display names can contain spaces (e.g. "山田　太郎"), but nobody
// types the space when mentioning — "@山田太郎" must still hit. Match each
// name both as-is and with all whitespace (half/full width) stripped.
const stripSpaces = (s: string) => s.replace(/[\s　]+/g, "");

// An @token: "@" must start the text or follow whitespace/punctuation (so an
// email address in the body isn't read as a mention), and the name runs until
// the next space or any punctuation people actually type after a name
// ("@黒崎さん、確認お願いします").
const MENTION_RE = /(^|[\s　、。,.:：;；!！?？「」『』()（）[\]【】<>＜＞"'`|/\\\n])@([^\s　、。,.:：;；!！?？「」『』()（）[\]【】<>＜＞"'`|/\\@\n]+)/g;

export function mentionTokens(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) if (m[2]) out.push(m[2]);
  return out;
}

// Resolve who a comment mentions. Two passes, because a mention that silently
// resolves to nobody is the worst failure this file can produce:
//   1. exact display name (longest first, so "黒崎" can't shadow "黒崎優斗")
//   2. whatever @token pass 1 left unclaimed — the family name alone
//      ("@黒崎" for 黒崎優斗), a different case ("@Kurosaki"), or the local
//      part of the member's email ("@taro")
export function resolveMentionedMembers<T extends MentionableMember>(body: string, members: T[]): T[] {
  if (body.includes("@全員")) return members;

  const sorted = members
    .filter((member) => member.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const hits: T[] = [];
  const claimed = new Set<T>();
  let remaining = body;

  for (const member of sorted) {
    const tags = [...new Set([`@${member.name}`, `@${stripSpaces(member.name)}`])];
    const hit = tags.filter((t) => remaining.includes(t));
    if (!hit.length) continue;
    hits.push(member);
    claimed.add(member);
    for (const t of hit) remaining = remaining.split(t).join("");
  }

  for (const token of mentionTokens(remaining)) {
    const t = stripSpaces(token).toLowerCase();
    if (t.length < 2) continue;
    for (const member of sorted) {
      if (claimed.has(member)) continue;
      const name = stripSpaces(member.name).toLowerCase();
      const local = (member.email ?? "").split("@")[0].toLowerCase();
      if (name.startsWith(t) || t.startsWith(name) || (local.length >= 2 && local === t)) {
        hits.push(member);
        claimed.add(member);
      }
    }
  }

  return hits;
}
