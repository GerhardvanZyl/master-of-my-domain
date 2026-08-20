// Per-listing pass — ONE paced loop that does every job needing a listing page,
// so the whole sync stays at a handful of JS approvals:
//   * full gallery URLs (galleryV2 omits floorplans on project pages, so this
//     regexes the page HTML instead — Domain puts the floorplan LAST)
//   * listingModel.price, which is how sold vs withdrawn is decided
//
// Substitute __TARGETS__ with [[listingUrl, externalId], ...] before running.
//
// PACING IS LOAD-BEARING: listing pages trip the WAF at ~12s spacing (~44 in a
// row). 45s + a 10-minute backoff on a challenge shell is the measured-safe
// cadence. Search pages are the tolerant ones; these are not.
//
// CHUNK THE TARGETS. At ~25 photos x ~172 chars, 40 listings is ~180KB raw and
// ~400KB percent-encoded — past what a hash-bridge navigation reliably carries.
// ~14 per chunk keeps it near the proven size. The bridge payload is built from
// THIS chunk only; the localStorage store is a resume log across chunks, and
// bridging the whole store would put every earlier chunk in the last URL.
(async () => {
  const TARGETS = __TARGETS__;
  const SPACING_MS = 45000;
  const BACKOFF_MS = 600000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = (u) => u.split("/").pop().split("?")[0];

  // Resume across a failed bridge trip: the paced loop is the expensive part,
  // and localStorage on domain.com.au survives navigating to the bridge and back.
  const KEY = "__momd_listing_pass";
  const store = JSON.parse(localStorage.getItem(KEY) || "{}");
  const out = {};

  async function readDoc(url) {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px";
    f.src = url;
    document.body.appendChild(f);
    try {
      for (let i = 0; i < 60; i++) {
        await sleep(350);
        let d;
        try {
          d = f.contentDocument;
        } catch {
          continue; // cross-origin mid-redirect
        }
        const el = d?.getElementById("__NEXT_DATA__");
        // Parsing IS the readiness test — the script tag streams, so it can be
        // present and long while its text is still arriving.
        if (el && el.textContent.length > 5000) {
          try {
            return { html: d.documentElement.outerHTML, nd: JSON.parse(el.textContent) };
          } catch {
            /* still streaming */
          }
        }
        // A redirect to /property-profile/ means the listing was withdrawn.
        if (d?.location?.href?.includes("/property-profile/") && d.readyState === "complete")
          return { profile: true };
      }
      // Poll exhausted. Do NOT assume WAF — that costs a 10-minute backoff, and
      // a withdrawn listing whose profile page never exposes __NEXT_DATA__ looks
      // identical from here. Inspect the final document and only back off on an
      // actual challenge/denial.
      try {
        const d = f.contentDocument;
        const href = d?.location?.href ?? "";
        const text = (d?.body?.innerText ?? "").slice(0, 2000);
        if (href.includes("/property-profile/")) return { profile: true };
        if (/access denied|sec-if-cpt|unusual traffic/i.test(text + (d?.title ?? "")))
          return null; // genuine WAF -> caller backs off
        return { unknown: true, href, text: text.slice(0, 300) };
      } catch {
        return null;
      }
    } finally {
      f.src = "about:blank";
      f.remove();
    }
  }

  for (const [url, ext] of TARGETS) {
    if (store[url] && store[url].status !== "waf") {
      out[url] = store[url]; // already fetched in an earlier chunk/attempt
      continue;
    }
    let r = null;
    try {
      r = await readDoc(url);
    } catch (e) {
      out[url] = { status: "error:" + String(e) };
    }
    if (r === null) {
      // Treat a challenge shell as a WAF trip: back off hard rather than burning
      // the rest of the list against a wall.
      out[url] = { status: "waf" };
      store[url] = out[url];
      localStorage.setItem(KEY, JSON.stringify(store));
      await sleep(BACKOFF_MS);
      continue;
    }
    if (r?.profile) {
      out[url] = { status: "withdrawn" };
    } else if (r?.unknown) {
      // Neither listing, profile, nor challenge — record it and move on at the
      // normal cadence rather than burning a backoff on an unexplained page.
      out[url] = { status: "unknown", href: r.href, text: r.text };
    } else if (r) {
      const cp = r.nd.props?.pageProps?.componentProps ?? {};
      const lm = cp.listingsMap?.[ext]?.listingModel ?? {};
      // UNION two sources — neither alone is complete:
      //  * the page HTML, because galleryV2 omits floorplans on project pages;
      //  * galleryV2 itself, because on some listings the gallery is rendered
      //    client-side and is simply absent from the serialized HTML (that gave
      //    8 Lure Ave exactly ONE image, its floorplan, and nothing else).
      // Do NOT exclude ")" from the class: the tail contains "no_upscale()" and
      // excluding it truncates every URL at "filters:format(webp".
      const fromHtml = r.html.match(/https:\/\/rimh2\.domainstatic\.com\.au\/[^"'\s\\<>]+/g) || [];
      const fromGallery = [];
      for (const p of cp.galleryV2?.photos ?? cp.gallery?.photos ?? []) {
        for (const v of [p?.desktopUrl?.["2x"], p?.desktopUrl?.["1x"], p?.url])
          if (typeof v === "string" && v.includes("rimh2")) fromGallery.push(v);
      }
      // The two sources need DIFFERENT trust rules.
      //
      // galleryV2 is authoritative: it IS this listing's gallery, whatever
      // listingId the filenames carry. A RELISTED property keeps the previous
      // listing's photo ids — 8 Lure Ave had 10 photos all prefixed
      // 2020487905_ and only its floorplan under its own id — so filtering
      // these by external_id silently discards the entire gallery.
      //
      // The page HTML is not: it carries a "similar listings" carousel of other
      // properties' covers plus agency logo/banner images. Accept a basename
      // there only if galleryV2 already vouched for that listingId, or it is
      // ours (which is how floorplans galleryV2 omits still get through).
      const idOf = (b) => (/^(\d+)_/.exec(b) || [])[1];
      const trusted = new Set([ext, ...fromGallery.map((u) => idOf(base(u))).filter(Boolean)]);
      const bySlot = new Map();
      for (const u of [...fromGallery, ...fromHtml]) {
        const m = /fit-in\/(\d+)x(\d+)\//.exec(u);
        const b = base(u);
        if (!m || !trusted.has(idOf(b))) continue;
        const px = +m[1] * +m[2];
        const prev = bySlot.get(b);
        if (!prev || px > prev.px) bySlot.set(b, { u, px });
      }
      const slot = (b) => +(/^\d+_(\d+)_/.exec(b)?.[1] ?? 0);
      const imgs = [...bySlot.entries()]
        .sort((a, b) => slot(a[0]) - slot(b[0]))
        .map(([, v]) => v.u);
      out[url] = {
        status: cp.listingSummary?.status ?? "live",
        price: lm.price ?? cp.listingSummary?.displayPrice ?? "",
        imgs,
      };
    }
    store[url] = out[url];
    localStorage.setItem(KEY, JSON.stringify(store));
    await sleep(SPACING_MS);
  }

  // COMPRESS before bridging — this is what lets one approval cover ~20+
  // listings instead of the 14 an uncompressed payload caps at. Three parts of
  // every image URL are redundant across a run:
  //   https://rimh2.domainstatic.com.au/  constant  -> dropped
  //   <sig>=                              unique    -> KEPT (it signs the exact
  //                                                    transform; a rebuilt URL
  //                                                    with the wrong one 403s)
  //   /fit-in/WxH/filters:...no_upscale()  few       -> dictionary index
  // ~172 chars a URL becomes ~66. scripts/_pass-expand.mjs rebuilds them.
  const P = "https://rimh2.domainstatic.com.au/";
  const tf = [];
  const pack = (u) => {
    if (!u.startsWith(P)) return "!" + u;
    const rest = u.slice(P.length);
    const i = rest.indexOf("/");
    const j = rest.lastIndexOf("/");
    if (i < 0 || j <= i) return "!" + u;
    const t = rest.slice(i, j);
    let k = tf.indexOf(t);
    if (k < 0) k = tf.push(t) - 1;
    return `${rest.slice(0, i)}|${k}|${rest.slice(j + 1)}`;
  };
  const packed = {};
  for (const [k, v] of Object.entries(out))
    packed[k] = v.imgs ? { ...v, imgs: v.imgs.map(pack) } : v;

  const enc = encodeURIComponent(JSON.stringify({ tf, d: packed }));
  location.href = "http://127.0.0.1:3300/#MOMD=" + enc;
  return {
    listings: Object.keys(out).length,
    waf: Object.values(out).filter((d) => d.status === "waf").length,
    encodedKB: Math.round(enc.length / 1024),
  };
})();
