/**
 * ワークスペースのタイムゾーンでの「今日」(YYYY-MM-DD)。
 *
 * 既存の todayIso() は UTC 固定で、JST の朝 9 時より前は前日を返す。「今日やる
 * こと」で1日ずれるのは致命的なので、workspaces.timezone (既定 Asia/Tokyo) で
 * 解釈する。この列は今までどの cron からも読まれていなかった。
 */
export async function workspaceToday(db: D1Database, wsId: string): Promise<{ date: string; timezone: string }> {
  const row = await db.prepare("SELECT timezone FROM workspaces WHERE id = ?").bind(wsId).first<{ timezone: string | null }>();
  const timezone = row?.timezone?.trim() || "Asia/Tokyo";
  return { date: localDate(new Date(), timezone), timezone };
}

/** ある瞬間を指定タイムゾーンの YYYY-MM-DD にする。 */
export function localDate(at: Date, timezone: string): string {
  try {
    // en-CA は YYYY-MM-DD を返すロケール。Workers の Intl で使える。
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
  } catch {
    // 不正なタイムゾーン名が入っていても今日を返せないと全体が落ちる。
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(at);
  }
}
