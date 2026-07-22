// Minimal service worker: makes the app installable (PWA) and shows a graceful
// offline page for navigations. It deliberately does NOT cache API/data
// responses — this is a live view of a local SQLite DB, and serving stale
// property data would be worse than useless.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(
    fetch(req).catch(
      () =>
        new Response(
          "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Offline</title><style>body{font-family:system-ui,sans-serif;background:#F4F1EA;color:#1c1c19;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}</style><h1>Offline</h1><p>Property Compare needs a connection to your local server.</p>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    ),
  );
});
