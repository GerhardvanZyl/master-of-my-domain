// Service worker: makes the app installable (PWA) and keeps pages you have
// already visited usable with no connection, so notes and photos can be
// captured at an inspection and synced later (see src/lib/outbox.ts).
//
// Strategy, deliberately small:
//   navigations       network-first, fall back to the cached copy, then to the
//                     offline page. Fresh data whenever there is a connection.
//   /_next/static/*   cache-first — the filenames are content-hashed.
//   images            cache-first — the photos are what you actually need
//                     offline, and they never change under a given URL.
//   everything else   untouched (API reads stay live; API writes are queued by
//                     the page, not here).
//
// ponytail: no precache manifest and no cache size cap. The shell is picked up
// the first time you load the app online, and this is a single-user library on
// a phone, not a public site. Add an LRU trim if the photo cache ever bothers
// you.
const CACHE = "pc-v2";

const OFFLINE_PAGE =
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Offline</title><style>body{font-family:system-ui,sans-serif;background:#F4F1EA;color:#1c1c19;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}p{color:#8c8a80;max-width:26rem;line-height:1.6}</style><h1>Offline</h1><p>This page hasn't been opened on this device yet, so there's no offline copy. Pages you've visited while connected stay available, and anything you write is saved and synced later.</p>";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

const isAsset = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname.startsWith("/_next/image") ||
  url.pathname.startsWith("/api/img/") ||
  url.pathname.startsWith("/api/media/") ||
  url.pathname.startsWith("/icons/");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // writes are the outbox's job
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // webfonts etc.

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: false }).then(
            (hit) =>
              hit ??
              new Response(OFFLINE_PAGE, {
                headers: { "content-type": "text/html; charset=utf-8" },
              }),
          ),
        ),
    );
    return;
  }

  if (!isAsset(url)) return; // API reads stay live — stale property data is worse than none

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
