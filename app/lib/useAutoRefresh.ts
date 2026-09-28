"use client";

import { useEffect, useRef } from "react";

// Keep a view fresh without realtime infra: refetch when the tab/app regains
// focus or becomes visible, plus a gentle interval while it's open. D1 has no
// push, so this is how changes from other devices / the AI (MCP) show up.
export function useAutoRefresh(fn: () => void, opts?: { intervalMs?: number; enabled?: boolean }) {
  const intervalMs = opts?.intervalMs ?? 15000;
  const enabled = opts?.enabled ?? true;
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      ref.current();
    };
    const iv = setInterval(run, intervalMs);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    // realtime: refetch instantly when a "changed" ping arrives (WebSocket)
    window.addEventListener("kotsukotsu:changed", run);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("kotsukotsu:changed", run);
    };
  }, [enabled, intervalMs]);
}
