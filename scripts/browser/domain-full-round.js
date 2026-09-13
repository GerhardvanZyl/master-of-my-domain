// Domain FULL ROUND in one unattended javascript_tool call.
//
// The operator gets ONE browser approval per sync, and any other browser
// action (even a navigation) spends it. So this does the feed harvest, the
// new/missing diff, the sold lookup AND the per-listing pass in a single call,
// then bridges everything home — one click, then walk away.
//
// What the live app already holds arrives INSIDE the call, as
// `window.__IDS = {a, b}` prepended by `scripts/_round-ids.mjs`: sorted Domain
// listing ids, delta-encoded base36, comma-separated. `a` = live VIC rows (the
// missing candidates), `b` = every other held Domain row. It cannot come in
// any other way: a fragment is dropped by Domain's own page load (measured
// 2026-09-13), and a cross-origin fetch to 127.0.0.1 is blocked by Private
// Network Access. Ids, not address keys, because ~1.6KB fits in the call and
// 22KB of keys does not — the price is that a relist under a new id reads as
// "new" here; the server merges it by address and node skips its gallery.
//
// Retry mode: `window.__T = [[path, why], ...]` (from `_round-ids.mjs
// --retry=<targets.json>`) skips the feed, diff and sold search and runs only
// the listing pass, bridging home as `domain-retry-gz`.
//
// Pacing, learned the hard way: SEARCH pages tolerate 1.3s. LISTING pages trip
// the WAF at ~12s spacing after ~44 in a row and then stay hot, so they get 45s
// and a 10-minute backoff. Keep the tab in the FOREGROUND — Chrome throttles
// timers in background tabs and stretches all of this out.
window.__D = { phase: "start", feed: 0, pass: 0, of: 0, err: null, done: false };
(async () => {
  const S = window.__D;
  const T = window.__T;
  const dec = (s) => {
    let v = 0;
    return s ? s.split(",").map((d) => (v += parseInt(d, 36))) : [];
  };
  const LIVE = new Set(dec(window.__IDS?.a));
  const HELD = new Set([...LIVE, ...dec(window.__IDS?.b)]);
  if (!HELD.size && !T) S.err = "no __IDS";
  const F = "bedrooms=3-any&bathrooms=2-any&carspaces=1-any";
  const SUBURBS = "suburb=point-cook-vic-3030,williams-landing-vic-3027,torquay-vic-3228,seabrook-vic-3028";
  const QS = `${SUBURBS}&${F}&price=600000-1100000&ssubs=0`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = (u) => (u || "").split("/").pop().split("?")[0];
  const idOf = (u) => Number(((u || "").match(/-(\d+)$/) || [])[1] || 0);

  // A document request is not challenged; a same-origin fetch of a Domain page
  // returns HTTP 200 with a ~2.5KB Akamai challenge body. Hence the iframe.
  // Never wait for onload — Domain's ad frames hold it open for minutes.
  // __NEXT_DATA__ STREAMS: it can be in the DOM while its text is still
  // arriving. Parsing IS the readiness test. A challenge shell has no
  // __NEXT_DATA__ at all, so null here means WAF (or a dead page).
  async function readPage(url, tries = 60) {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px";
    f.src = url;
    document.body.appendChild(f);
    try {
      for (let i = 0; i < tries; i++) {
        await sleep(350);
        try {
          const d = f.contentDocument;
          const href = d?.location?.href;
          // A withdrawn listing redirects to /property-profile/ with no listingModel.
          if (href && /\/property-profile\//.test(href) && d.readyState === "complete") {
            return { nd: null, html: null, url: href, profile: true };
          }
          const el = d?.getElementById("__NEXT_DATA__");
          if (!el) continue;
          let nd;
          try { nd = JSON.parse(el.textContent); } catch { continue; }
          let html = null;
          try { html = d.documentElement.outerHTML; } catch {}
          return { nd, html, url: href ?? url };
        } catch { /* cross-origin during redirect — keep polling */ }
      }
      return null;
    } finally {
      f.src = "about:blank";
      f.remove();
    }
  }
  const readListing = async (url) => {
    const r = await readPage(url);
    if (r) return r;
    S.phase = "backoff";
    await sleep(600000);
    S.phase = "pass";
    return readPage(url);
  };
  const listingsOf = (r) => r?.nd?.props?.pageProps?.componentProps?.listingsMap ?? {};

  // ---------- phase 1: search feed ----------
  S.phase = "feed";
  const rows = [], seen = new Set();
  let pages = 0;
  try {
    for (let p = 1; !T && p <= 25; p++) {
      const map = listingsOf(await readPage(`/sale/?${QS}&page=${p}`));
      const ids = Object.keys(map);
      if (!ids.length) { if (p === 1) S.err = "feed page 1 empty"; break; }
      pages = p;
      for (const k of ids) {
        const m = map[k].listingModel ?? {};
        if (!m.url || seen.has(m.url)) continue;
        seen.add(m.url);
        const a = m.address ?? {}, ft = m.features ?? {};
        rows.push([m.url, m.price ?? "", m.tags?.tagText ?? "", ft.beds ?? null, ft.baths ?? null,
          ft.parking ?? null, ft.landSize ?? null, a.street ?? "", a.suburb ?? "", a.postcode ?? "",
          a.state ?? "", a.lat ?? null, a.lng ?? null, m.inspection?.openTime ?? null,
          ft.propertyTypeFormatted ?? "", base(m.images?.[0])]);
      }
      S.feed = rows.length;
      await sleep(1300);
    }
  } catch (e) { S.err = String(e); }

  // ---------- phase 2: diff by listing id ----------
  S.phase = "diff";
  // House-and-land never enters the DB, and must be dropped EVERY round or the
  // ones relisted under a tidied address come back as new each time.
  const isHnl = (street, type) =>
    /^new /i.test(type || "") || /off the plan/i.test(type || "") ||
    /^lot\b|turnkey|^corner\b/i.test(street || "") || / Grove - /.test(street || "");
  const inFeed = new Set(), targets = [];
  for (const r of HELD.size ? rows : []) {
    const [url, price, tag, , , , , street] = r;
    const id = idOf(url);
    inFeed.add(id); // RAW feed — a house-and-land listing is still live
    if (isHnl(street, r[14])) continue;
    // Domain keeps sold/under-offer listings IN the feed. Only "sold" is settled.
    if (!HELD.has(id)) targets.push({ url, why: "new", extId: String(id) });
    else if (LIVE.has(id) && (/\bsold\b/i.test(price) || /\bsold\b/i.test(tag))) targets.push({ url, why: "sold?", extId: String(id) });
  }
  // MISSING is judged against the RAW feed; LIVE is VIC-only, so the frozen NSW
  // rows can never be swept in.
  const missing = [...LIVE].filter((id) => !inFeed.has(id));

  // ---------- phase 3: sold search (WAF-tolerant) ----------
  // A missing listing that sold shows up here, with its price and sale text,
  // for the cost of a search page rather than a 45s listing fetch.
  S.phase = "sold";
  const want = new Set(missing), sold = [];
  try {
    for (let p = 1; p <= 15 && want.size; p++) {
      const map = listingsOf(await readPage(`/sold-listings/?${SUBURBS}&${F}&ssubs=0&page=${p}`));
      const ids = Object.keys(map);
      if (!ids.length) break;
      for (const k of ids) {
        const m = map[k].listingModel ?? {};
        const id = idOf(m.url);
        if (!want.has(id)) continue;
        want.delete(id);
        sold.push([id, m.url, m.price ?? "", m.tags?.tagText ?? ""]);
      }
      await sleep(1300);
    }
  } catch (e) { S.err = String(e); }
  // Not found sold: fetch its own page by bare id. A redirect to the listing or
  // to /property-profile/ decides it; anything else comes home unresolved.
  for (const id of want) targets.push({ url: "/" + id, why: "missing", extId: String(id) });
  for (const [url, why] of T ?? []) targets.push({ url, why, extId: String(idOf(url)) });

  // ---------- phase 4: per-listing pass ----------
  S.phase = "pass";
  S.of = targets.length;
  const out = [], errs = [];
  // rimh2 URLs end in `no_upscale()` — excluding ")" truncates every one of
  // them at "filters:format(webp".
  const IMG_RE = /https:\/\/rimh2\.domainstatic\.com\.au\/[^"'\s\\<>]+/g;
  const wOf = (u) => Number((u.match(/fit-in\/(\d+)x/) || [])[1] || 0);
  for (const t of targets) {
    try {
      const r = await readListing(t.url);
      if (!r) errs.push({ ...t, err: "timeout" });
      else if (r.profile) out.push({ ...t, final: r.url, status: "withdrawn" });
      else {
        const cp = r.nd.props?.pageProps?.componentProps ?? {};
        const lm = cp.listingSummary ?? cp.listingModel;
        if (!lm) out.push({ ...t, final: r.url, status: "unresolved" });
        else {
          // desktopUrl is an OBJECT keyed by density ({"1x": ..., "2x": ...}),
          // not a string — "1x" is the fit-in/1920x1080 form the library
          // stores. Treating it as a string threw on every listing (2026-09-13).
          const g = (cp.galleryV2?.photos ?? [])
            .map((p) => (typeof p.desktopUrl === "string" ? p.desktopUrl : p.desktopUrl?.["1x"] ?? p.desktopUrl?.["2x"]))
            .filter((u) => typeof u === "string");
          // galleryV2 is AUTHORITATIVE — take it all, whatever listingId its
          // filenames carry. A relisted property keeps the previous listing's
          // photo ids, so filtering these by external_id throws the gallery away.
          const okIds = new Set(g.map((u) => (base(u).match(/^(\d+)_/) || [])[1]).filter(Boolean));
          okIds.add(t.extId);
          // The page HTML catches floorplans galleryV2 omits, but also carries a
          // "similar listings" carousel of OTHER properties' covers — so a
          // basename counts only if galleryV2 vouched for its listingId.
          const extra = [...new Set((r.html || "").match(IMG_RE) || [])]
            .filter((u) => /fit-in\/\d+x\d+/.test(u))
            .filter((u) => okIds.has((base(u).match(/^(\d+)_/) || [])[1]));
          const best = new Map();
          for (const u of [...g, ...extra]) {
            const b = base(u).replace(/^(\d+_\d+)_.*/, "$1");
            if (!best.has(b) || wOf(u) > wOf(best.get(b))) best.set(b, u);
          }
          const photos = [...best.entries()]
            .sort((a, c) => Number((a[0].match(/_(\d+)$/) || [])[1] || 0) - Number((c[0].match(/_(\d+)$/) || [])[1] || 0))
            .map(([, u]) => u);
          const price = typeof lm.price === "string" ? lm.price : "";
          out.push({ ...t, final: r.url, price, status: /\bsold\b/i.test(price) ? "sold" : null, photos,
            beds: lm.beds ?? null, baths: lm.baths ?? null, parking: lm.parking ?? null });
        }
      }
    } catch (e) {
      errs.push({ ...t, err: String(e && e.message ? e.message : e) });
    }
    S.pass++;
    await sleep(45000);
  }

  // ---------- bridge home ----------
  // Kept in localStorage first: if the bridge navigation fails, a tiny
  // no-prompt call can re-send it instead of re-running the round.
  S.phase = "bridge";
  const name = T ? "domain-retry-gz" : "domain-round-gz";
  const json = JSON.stringify({ pages, feed: rows, targets, missing, sold, out, errs, err: S.err });
  const gz = new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")));
  const bytes = new Uint8Array(await gz.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const d = encodeURIComponent(btoa(bin));
  try { localStorage.setItem(name, d); } catch {}
  S.done = true;
  location.href = `http://127.0.0.1:3300/#name=${name}&d=${d}`;
})();
