"use client";

import { useEffect, useRef } from "react";
import { RT_HOST } from "../lib/hosts";

const RT_WS = `wss://${RT_HOST}/ws`;

// リアルタイム Worker の宛先。Pages の入口 (pages.dev / 独自ドメイン kotukotu.app) から
// 開いた画面は同じアドレスの /ws を使う (Pages が service binding で kotsukotsu-rt へ渡す)。
// workers.dev や localhost で開いたときは従来どおり直接つなぐ。
function rtEndpoint(): string {
  const host = window.location.host;
  const viaPages = host.endsWith(".pages.dev") || host === "kotukotu.app" || host.endsWith(".kotukotu.app");
  return viaPages ? `wss://${host}/ws` : RT_WS;
}

// Opens a WebSocket to the realtime worker for the active workspace.
//  - incoming "changed" ping  -> dispatch window "kotsukotsu:changed" (views refetch)
//  - local "kotsukotsu:mutated" (from api()) -> send "changed" so other devices refetch
// Auto-reconnects; the 15s polling in useAutoRefresh stays as a fallback.
export default function RealtimeBridge({ workspaceId }: { workspaceId: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${rtEndpoint()}?ws=${encodeURIComponent(workspaceId)}`);
      } catch {
        retry = setTimeout(connect, 5000);
        return;
      }
      wsRef.current = ws;
      ws.onmessage = () => window.dispatchEvent(new Event("kotsukotsu:changed"));
      ws.onopen = () => {
        ping = setInterval(() => { try { ws.send("ping"); } catch { /* ignore */ } }, 45000);
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (ping) { clearInterval(ping); ping = null; }
        if (!closed) retry = setTimeout(connect, 5000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    };

    const onMutated = () => { try { wsRef.current?.send("changed"); } catch { /* not open */ } };
    window.addEventListener("kotsukotsu:mutated", onMutated);
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      window.removeEventListener("kotsukotsu:mutated", onMutated);
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, [workspaceId]);
  return null;
}
