"use client";

// アイコンを出せる最小の形。GoalMember / NodeMemberRow / Member のどれでも通る。
export type AvatarPerson = {
  id: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
  can_edit?: boolean;
};

// アサインの見せ方はここに一本化する。以前は各画面が -space-x-1.5 で
// アイコンを重ねていたので、7人アサインされたゴールでは誰が誰だか分からない
// 団子になっていた。重ねずに間隔を空け、入り切らない分は +N にまとめる。

// 写真の無い人は頭文字アイコンになる。全員同じ緑だと「小」「尾」「野」が
// 並んだときに一塊に見えるので、id から決まる色を割り当てて見分けられるように
// する (同じ人はどの画面でも同じ色)。
const HUES = [145, 210, 265, 24, 340, 190, 95, 300, 45, 165];

export function avatarHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

function initial(name: string, email: string | null): string {
  const s = (name || email || "?").trim();
  return (s[0] || "?").toUpperCase();
}

export function Avatar({
  member,
  size = 24,
  showLock = false,
}: {
  member: AvatarPerson;
  size?: number;
  showLock?: boolean;
}) {
  const label = member.name || member.email || "?";
  // can_edit を持たないデータ源 (ノードのアサイン) では権限の話をしない
  const viewOnly = member.can_edit === false;
  const title = viewOnly ? `${label}（閲覧のみ）` : label;
  const box: React.CSSProperties = {
    width: size,
    height: size,
    // 背景色と同じリングを1本入れて、写真アイコンでも輪郭が立つようにする
    boxShadow: "0 0 0 1px var(--border-strong)",
  };
  const inner = member.avatar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={member.avatar} alt={label} className="w-full h-full rounded-full object-cover" />
  ) : (
    <span
      className="w-full h-full rounded-full flex items-center justify-center font-bold text-white"
      style={{ background: `hsl(${avatarHue(member.id)} 42% 46%)`, fontSize: Math.round(size * 0.42) }}
    >
      {initial(member.name, member.email ?? null)}
    </span>
  );
  return (
    <span className="relative inline-flex shrink-0 rounded-full" style={box} title={title}>
      {inner}
      {/* 「閲覧のみ」は例外なので、その人にだけ鍵を出す (編集可はペンを出さない) */}
      {showLock && viewOnly && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[var(--surface)] flex items-center justify-center text-[var(--muted)]"
          style={{ width: Math.round(size * 0.44), height: Math.round(size * 0.44), boxShadow: "0 0 0 1px var(--border)" }}
          aria-hidden
        >
          <svg width={Math.round(size * 0.28)} height={Math.round(size * 0.28)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
      )}
    </span>
  );
}

/**
 * アサインされた人の一覧。重ねない。
 * - 0人           → 何も出さない (未アサインの表現は呼び出し側に任せる)
 * - 1人 + withName → アイコン + 名前
 * - それ以外       → アイコンを max 件まで並べて、残りは +N
 */
export function Assignees({
  members,
  size = 24,
  max = 3,
  withName = false,
  showLock = false,
  className = "",
}: {
  members: AvatarPerson[];
  size?: number;
  max?: number;
  withName?: boolean;
  showLock?: boolean;
  className?: string;
}) {
  if (!members.length) return null;
  const shown = members.slice(0, max);
  const rest = members.slice(max);
  const restLabel = rest.map((m) => m.name || m.email || "?").join("、");
  return (
    <div className={`flex items-center gap-1 shrink-0 ${className}`}>
      {shown.map((m) => (
        <Avatar key={m.id} member={m} size={size} showLock={showLock} />
      ))}
      {rest.length > 0 && (
        <span
          title={restLabel}
          className="inline-flex items-center justify-center shrink-0 rounded-full font-bold text-[var(--muted)] bg-[var(--hover)]"
          style={{ height: size, minWidth: size, padding: "0 5px", fontSize: Math.round(size * 0.42), boxShadow: "0 0 0 1px var(--border-strong)" }}
        >
          +{rest.length}
        </span>
      )}
      {withName && members.length === 1 && (
        <span className="text-[13px] text-[var(--foreground-soft)] truncate max-w-[8rem]" title={members[0].name}>
          {members[0].name}
        </span>
      )}
    </div>
  );
}

/** 未アサインを明示したい行で使う点線マル。 */
export function UnassignedAvatar({ size = 24 }: { size?: number }) {
  return (
    <span
      aria-hidden
      title="未アサイン"
      className="inline-flex items-center justify-center shrink-0 rounded-full text-[var(--muted-soft)]"
      style={{ width: size, height: size, border: "1px dashed var(--border-strong)", fontSize: Math.round(size * 0.4) }}
    >
      未
    </span>
  );
}
