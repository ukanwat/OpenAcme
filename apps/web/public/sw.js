// OpenAcme service worker. Three responsibilities only:
//   1. install/activate — take over fast, no precache (thin SPA shell).
//   2. push — render a notification from the JSON payload.
//   3. notificationclick — focus an existing tab on the target URL or
//      open a new one.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "OpenAcme", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "OpenAcme";
  const body = payload.body || "";
  // tag = sessionId so a chatty agent doesn't pile up the lock screen —
  // newer notification with the same tag replaces older.
  const tag = payload.tag || "openacme";
  const url = payload.url || "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // renotify: true makes a same-tag replacement still alert the user
      // (sound/vibration). Without this, sub-second updates are silent
      // — fine for an active chat, but it makes the test ping flow
      // confusing because the second test fires no audible alert.
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || "/",
    self.location.origin
  ).href;
  event.waitUntil(
    (async () => {
      // includeUncontrolled: true is critical — without it, a freshly-
      // installed SW returns zero clients and the focus path always
      // falls through to openWindow.
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        try {
          const url = new URL(client.url);
          if (url.origin === self.location.origin && "focus" in client) {
            if ("navigate" in client && client.url !== target) {
              await client.navigate(target);
            }
            return client.focus();
          }
        } catch {
          // skip malformed urls
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
    })()
  );
});
