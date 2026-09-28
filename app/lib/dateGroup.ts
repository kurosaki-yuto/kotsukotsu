import type { DoneEntry } from "./db";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

export function jstDateKey(iso: string): string {
  const d = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

export function jstHourMinute(iso: string): string {
  const d = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return d.toISOString().slice(11, 16);
}

export function labelForKey(key: string): string {
  const todayKey = jstDateKey(new Date().toISOString());
  const yKey = jstDateKey(new Date(Date.now() - 86400_000).toISOString());
  if (key === todayKey) return "今日";
  if (key === yKey) return "昨日";
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${key} (${WEEKDAY[dt.getUTCDay()]})`;
}

export function groupByDate(entries: DoneEntry[]): { key: string; label: string; items: DoneEntry[] }[] {
  const buckets = new Map<string, DoneEntry[]>();
  for (const e of entries) {
    const k = jstDateKey(e.completed_at);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(e);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([key, items]) => ({ key, label: labelForKey(key), items }));
}
