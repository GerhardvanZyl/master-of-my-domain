// Service worker: the only extension context allowed to POST cross-origin to
// http://localhost:3225 (granted via host_permissions — no CORS/mixed-content
// concerns). Forwards the captured payload to the app's ingest endpoint.
// Points at the LIVE app on .125, not localhost — that is the instance that
// matters (see CLAUDE.md). Nothing listens on localhost:3225 on the dev box.
const INGEST_URL = "http://192.168.68.125:3225/api/ingest";

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ingest" || typeof msg.json !== "string") return;
  fetch(INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: msg.json,
  })
    .then((r) => r.json())
    .then((d) => console.log("[momd] ingested", d))
    .catch((e) => console.warn("[momd] ingest failed", e));
});
