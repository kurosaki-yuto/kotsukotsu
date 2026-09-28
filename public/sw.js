// こつこつ service worker — PWA + Web Push.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The browser can invalidate/rotate a push subscription at any time (key
// rotation, storage eviction, etc). Without this, a device that once enabled
// notifications silently stops receiving them until the user notices and
// re-taps 通知オン. Re-subscribe automatically and re-register with the
// server so the device just keeps getting pushed forever.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
        let sub = event.newSubscription;
        if (!sub) {
          const keyRes = await fetch("/api/push/key", { credentials: "include" });
          const { key } = await keyRes.json();
          if (!key) return;
          sub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key),
          });
        }
        const j = sub.toJSON();
        await fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
        });
        if (oldEndpoint && oldEndpoint !== j.endpoint) {
          await fetch("/api/push/subscribe", {
            method: "DELETE",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: oldEndpoint }),
          }).catch(() => {});
        }
      } catch (e) {
        /* best-effort — worst case the user re-taps 通知オン */
      }
    })()
  );
});

// Push: no-payload pushes are used, so fetch the latest unread notification and
// show it. If a payload is present (future), prefer it.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "こつこつ";
      let body = "新しい通知があります";
      let url = "/notifications";
      try {
        if (event.data) {
          const d = event.data.json();
          if (d && d.title) {
            title = d.title;
            body = d.body || "";
            url = d.url || url;
          }
        } else {
          const res = await fetch("/api/notifications?filter=unread", { credentials: "include" });
          if (res.ok) {
            const payload = await res.json();
            // paginated response ({items, hasMore}); older builds returned a bare array
            const list = Array.isArray(payload) ? payload : payload && payload.items;
            if (Array.isArray(list) && list.length) {
              const n = list[0];
              title = n.title || title;
              body = n.body || "";
              if (n.goal_id) url = "/goals/" + n.goal_id;
            }
          }
        }
      } catch (e) {
        /* fall back to the generic notification */
      }
      await self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        if ("focus" in c) {
          try { await c.navigate(url); } catch (e) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});
