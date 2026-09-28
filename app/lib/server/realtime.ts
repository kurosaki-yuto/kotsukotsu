import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

type RTEnv = { RT_URL?: string; RT_SECRET?: string };

// Tell the realtime worker that a workspace changed; it broadcasts a "changed"
// ping to all connected devices so they refetch. Used for server-originated
// changes (e.g. the AI via MCP path that reaches the app). UI edits are
// broadcast directly by the acting client over its own WebSocket.
export function notifyWorkspace(wsId: string): void {
  try {
    const e = getCloudflareContext().env as unknown as RTEnv;
    if (!e.RT_URL || !e.RT_SECRET) return;
    const p = fetch(`${e.RT_URL}/notify?ws=${encodeURIComponent(wsId)}`, {
      method: "POST",
      headers: { "x-rt-secret": e.RT_SECRET },
    }).then(() => undefined).catch(() => undefined);
    const ctx = (getCloudflareContext() as unknown as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } }).ctx;
    if (ctx?.waitUntil) ctx.waitUntil(p);
  } catch {
    /* no context / not configured */
  }
}
