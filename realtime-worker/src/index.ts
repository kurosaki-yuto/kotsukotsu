/**
 * こつこつ realtime — Cloudflare Durable Object + WebSocket fan-out.
 *
 * One Durable Object instance per workspace (addressed by workspace id) holds
 * the live WebSocket connections for that workspace. When the app (or the MCP
 * worker) mutates data it POSTs /notify; the DO broadcasts a tiny "changed"
 * ping to every connected client, which then refetches. Pings carry NO data —
 * the real data still comes from the authenticated app API — so a leaked ping
 * is harmless.
 *
 * Endpoints (outer worker):
 *   GET  /ws?ws=<id>      -> WebSocket upgrade, joins the workspace room
 *   POST /notify?ws=<id>  -> broadcast (requires x-rt-secret)
 *   GET  /health          -> ok
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  RT_SECRET: string;
}

export class Room {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      // Hibernation API: the runtime keeps the socket across DO eviction.
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/notify") {
      const msg = JSON.stringify({ t: "changed" });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(msg); } catch { /* dead socket */ }
      }
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  // "ping" -> keepalive; "changed" -> a client made an edit, fan it out to every
  // connected device so they refetch (no server round-trip needed for UI edits).
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") {
      try { ws.send("pong"); } catch { /* ignore */ }
      return;
    }
    if (message === "changed") {
      const msg = JSON.stringify({ t: "changed" });
      for (const s of this.state.getWebSockets()) {
        try { s.send(msg); } catch { /* dead socket */ }
      }
    }
  }
  webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* ignore */ }
  }
  webSocketError() {}
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    const wsId = url.searchParams.get("ws");
    if (!wsId) return new Response("ws required", { status: 400 });
    const stub = env.ROOM.get(env.ROOM.idFromName(wsId));

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return stub.fetch(req);
    }
    if (url.pathname === "/notify") {
      if (req.headers.get("x-rt-secret") !== env.RT_SECRET) return new Response("forbidden", { status: 403 });
      return stub.fetch(new Request("https://do/notify", { method: "POST" }));
    }
    return new Response("not found", { status: 404 });
  },
};
