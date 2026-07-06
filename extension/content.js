// Isolated-world relay: receives the collected payload from injected.js (MAIN
// world) and forwards it to the background worker, which does the cross-origin
// POST to the local app.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "momd-collect" || typeof d.json !== "string") return;
  chrome.runtime.sendMessage({ type: "ingest", json: d.json });
});
