// Domain FULL ROUND in one unattended javascript_tool call.
//
// Domain's JS approval is per-call and cannot be made persistent, so an
// operator who has to click every call cannot leave the machine. This does the
// feed harvest, the new/changed/missing diff, AND the per-listing pass in a
// single call, then bridges everything home — one click, then walk away.
//
// The diff normally runs in node (`_feed-sync.mjs` + `_sync-diff-live.mjs`),
// which is why HELD is injected: it is the live app's 512 address keys and what
// we hold against each, so the browser can decide what needs a listing page
// without a round trip node could not make anyway (a cross-origin fetch from
// domain.com.au to 127.0.0.1 is blocked by Private Network Access).
//
// Pacing, learned the hard way: SEARCH pages tolerate 1.3s. LISTING pages trip
// the WAF at ~12s spacing after ~44 in a row and then stay hot, so they get 45s
// and a 10-minute backoff. Keep the tab in the FOREGROUND — Chrome throttles
// timers in background tabs and stretches all of this out.
window.__D = { phase: "start", feed: 0, pass: 0, of: 0, err: null, done: false };
(async () => {
  const S = window.__D;
  // HELD arrives in the fragment, put there by the receiver's /handoff redirect
  // (see scripts/_receiver.mjs): key -> [externalId, listingUrl, priceDisplay,
  // delisted, saleStatus, state]. Fragment, not an injected literal, so 80KB of
  // address keys never passes through the agent's context.
  let HELD = null;
  try {
    const raw = Uint8Array.from(atob(decodeURIComponent(location.hash.replace(/^#HELD=/, ""))), (c) => c.charCodeAt(0));
    HELD = JSON.parse(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
  } catch (e) {
    // No handoff payload. Harvest the feed anyway and bridge it back rather
    // than aborting — the diff can then be done in node, at the cost of one
    // more approval for the listing pass, which beats losing the whole run.
    S.err = "no HELD: " + String(e && e.message ? e.message : e);
  }
  history.replaceState(null, "", location.pathname + location.search);
  const SUBURBS = "point-cook-vic-3030,williams-landing-vic-3027,torquay-vic-3228,seabrook-vic-3028";
  const QS = `suburb=${SUBURBS}&bedrooms=3-any&bathrooms=2-any&carspaces=1-any&price=600000-1100000&ssubs=0`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = (u) => (u || "").split("/").pop().split("?")[0];

  // Mirrors addressKey() in src/scrape/persist.ts — the function upsertProperty
  // consults. If these two drift, the round predicts "new" for rows the server
  // will merge, and /api/batch has no DELETE to undo a duplicate.
  const addrKey = (street, suburb) => {
    if (!street) return null;
    const k = street
      .toLowerCase()
      .replace(/\bstreet\b/g, "st").replace(/\broad\b/g, "rd").replace(/\bdrive\b/g, "dr")
      .replace(/\bavenue\b/g, "ave").replace(/\bcrescent\b/g, "cres").replace(/\bcourt\b/g, "ct")
      .replace(/\bplace\b/g, "pl").replace(/\bboulevard\b/g, "blvd").replace(/\bcircuit\b/g, "cct")
      .replace(/[^a-z0-9/]+/g, " ").trim();
    return k ? `${k}|${(suburb ?? "").toLowerCase().trim()}` : null;
  };

  // A document request is not challenged; a same-origin fetch of a Domain page
  // returns HTTP 200 with a ~2.5KB Akamai challenge body. Hence the iframe.
  // Never wait for onload — Domain's ad frames hold it open for minutes.
  // __NEXT_DATA__ STREAMS: it can be in the DOM and past 5000 chars while its
  // text is still arriving. Parsing IS the readiness test.
  async function readPage(url, tries = 60) {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px";
    f.src = url;
    document.body.appendChild(f);
    try {
      for (let i = 0; i < tries; i++) {
        await sleep(350);
        let el, html = null;
        try {
          el = f.contentDocument?.getElementById("__NEXT_DATA__");
          if (el && el.textContent.length > 5000) {
            let nd;
            try { nd = JSON.parse(el.textContent); } catch { continue; }
            try { html = f.contentDocument.documentElement.outerHTML; } catch {}
            return { nd, html, url: f.contentDocument?.location?.href ?? url };
          }
          // A withdrawn listing redirects to /property-profile/ and has no
          // listingModel at all — detect it rather than timing out.
          const href = f.contentDocument?.location?.href;
          if (href && /\/property-profile\//.test(href) && f.contentDocument.readyState === "complete") {
            return { nd: null, html: null, url: href, profile: true };
          }
        } catch { /* cross-origin during redirect — keep polling */ }
      }
      return null;
    } finally {
      f.src = "about:blank";
      f.remove();
    }
  }

  // ---------- phase 1: search feed ----------
  S.phase = "feed";
  const rows = [], seen = new Set();
  let pages = 0;
  try {
    for (let p = 1; p <= 25; p++) {
      const r = await readPage(`/sale/?${QS}&page=${p}`);
      if (!r?.nd) { S.err = `feed page ${p}: no __NEXT_DATA__`; break; }
      const map = r.nd.props?.pageProps?.componentProps?.listingsMap ?? {};
      const ids = Object.keys(map);
      if (!ids.length) break;
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

  // ---------- phase 2: diff, in-browser ----------
  S.phase = "diff";
  // House-and-land never enters the DB, and must be dropped EVERY round or the
  // ones relisted under a tidied address come back as new each time.
  const isHnl = (street, type) =>
    /^new /i.test(type || "") || /off the plan/i.test(type || "") ||
    /^lot\b|turnkey|^corner\b/i.test(street || "") || / Grove - /.test(street || "");

  const feedKeys = new Set();
  const targets = [], priceChanges = [];
  for (const r of HELD ? rows : []) {
    const [url, price, tag, , , , , street, suburb] = r;
    const k = addrKey(street, suburb);
    if (k) feedKeys.add(k); // RAW feed — a house-and-land listing is still live
    if (isHnl(street, r[14])) continue;
    const held = k ? HELD[k] : null;
    const extId = (url.match(/-(\d+)$/) || [])[1] || null;
    if (!held) {
      targets.push({ url, why: "new", extId });
    } else {
      // Domain keeps sold/under-offer listings IN the feed. Only "sold" is
      // settled; "Under offer"/"Under contract" stays live.
      if (/\bsold\b/i.test(price) || /\bsold\b/i.test(tag)) targets.push({ url, why: "sold?", extId });
      else if (!/\$/.test(price) && price) targets.push({ url, why: "no-price", extId });
      else if (price && price !== held[2]) priceChanges.push({ listingUrl: held[1], was: held[2], now: price, key: k });
    }
  }
  // MISSING is judged against the RAW feed. The suburb/state filter is
  // essential: without it the 25 frozen NSW rows read as missing every round.
  for (const [k, v] of Object.entries(HELD ?? {})) {
    if (v[3] === 1 || v[4] === "sold" || v[5] !== "VIC") continue;
    if (feedKeys.has(k)) continue;
    if (!/domain\.com\.au/.test(v[1])) continue; // an REA-only row is not missing from Domain
    targets.push({ url: v[1], why: "missing", extId: v[0] || null });
  }

  // ---------- phase 3: per-listing pass ----------
  S.phase = "pass";
  S.of = targets.length;
  const out = [], errs = [];
  // rimh2 URLs end in `no_upscale()` — excluding ")" truncates every one of
  // them at "filters:format(webp".
  const IMG_RE = /https:\/\/rimh2\.domainstatic\.com\.au\/[^"'\s\\<>]+/g;
  const bn = (u) => (u.split("/").pop() || "").split("?")[0];
  const wOf = (u) => Number((u.match(/fit-in\/(\d+)x/) || [])[1] || 0);

  for (const t of targets) {
    try {
      const r = await readPage(t.url);
      if (!r) { errs.push({ ...t, err: "timeout" }); await sleep(45000); continue; }
      if (r.profile || !r.nd) { out.push({ ...t, status: "withdrawn" }); await sleep(45000); continue; }
      const cp = r.nd.props?.pageProps?.componentProps ?? {};
      const lm = cp.listingSummary ?? cp.listingModel ?? {};
      // galleryV2 is AUTHORITATIVE — take it all, whatever listingId its
      // filenames carry. A relisted property keeps the previous listing's photo
      // ids, so filtering these by external_id throws the gallery away.
      const g = (cp.galleryV2?.photos ?? []).map((p) => p.desktopUrl).filter(Boolean);
      const okIds = new Set(g.map((u) => (bn(u).match(/^(\d+)_/) || [])[1]).filter(Boolean));
      if (t.extId) okIds.add(String(t.extId));
      // The page HTML catches floorplans galleryV2 omits on project pages, but
      // also carries a "similar listings" carousel of OTHER properties' covers
      // and agency logos — so a basename is accepted only if galleryV2 already
      // vouched for its listingId (or it is ours).
      const extra = [...new Set((r.html || "").match(IMG_RE) || [])]
        .filter((u) => /fit-in\/\d+x\d+/.test(u))
        .filter((u) => okIds.has((bn(u).match(/^(\d+)_/) || [])[1]));
      const bestByBase = new Map();
      for (const u of [...g, ...extra]) {
        const b = bn(u).replace(/^(\d+_\d+)_.*/, "$1");
        if (!bestByBase.has(b) || wOf(u) > wOf(bestByBase.get(b))) bestByBase.set(b, u);
      }
      const photos = [...bestByBase.entries()]
        .sort((a, c) => Number((a[0].match(/_(\d+)$/) || [])[1] || 0) - Number((c[0].match(/_(\d+)$/) || [])[1] || 0))
        .map(([, u]) => u);
      const price = lm.price ?? cp.listingSummary?.price ?? "";
      out.push({
        ...t,
        price,
        // "SOLD - $X" is Domain's own settled form; plain "Under offer" is not.
        status: /\bsold\b/i.test(price) ? "sold" : null,
        photos,
        beds: lm.beds ?? null, baths: lm.baths ?? null, parking: lm.parking ?? null,
      });
    } catch (e) {
      errs.push({ ...t, err: String(e && e.message ? e.message : e) });
    }
    S.pass++;
    await sleep(45000);
  }

  // ---------- bridge home ----------
  S.phase = "bridge";
  S.done = true;
  const json = JSON.stringify({ pages, feed: rows, targets, priceChanges, out, errs, err: S.err });
  const gz = new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")));
  const bytes = new Uint8Array(await gz.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  location.href = "http://127.0.0.1:3300/#name=domain-round-gz&d=" + encodeURIComponent(btoa(bin));
})();
