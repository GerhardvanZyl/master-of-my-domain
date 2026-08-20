// Domain SEARCH-FEED harvest — paste as ONE javascript_tool call on a
// www.domain.com.au tab. Costs a single JS approval and ends by navigating
// itself to the local receiver, so no second approval is needed to poll.
//
// Why an iframe: since 2026-08-07 a same-origin `fetch` of a Domain page returns
// HTTP 200 with a ~2.5KB Akamai bot-challenge body instead of the real HTML. A
// document request (iframe src) is not challenged. Never wait for onload — Domain's
// ad frames block it for minutes; poll for #__NEXT_DATA__ instead, which is in the
// initial HTML.
//
// Only images[0] is kept per listing: that basename IS the og:image cover (hero),
// and full galleries come from the per-listing pass. Keeping all ~21 URLs per
// listing pushed the hash bridge past 200KB for no benefit.
(async () => {
  const SUBURBS =
    "point-cook-vic-3030,williams-landing-vic-3027,torquay-vic-3228,seabrook-vic-3028";
  const QS = `suburb=${SUBURBS}&bedrooms=3-any&bathrooms=2-any&carspaces=1-any&price=600000-1100000&ssubs=0`;
  const base = (u) => (u || "").split("/").pop().split("?")[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function readPage(url) {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px";
    f.src = url;
    document.body.appendChild(f);
    try {
      for (let i = 0; i < 40; i++) {
        await sleep(350);
        let el;
        try {
          el = f.contentDocument?.getElementById("__NEXT_DATA__");
        } catch {
          /* cross-origin during redirect — keep polling */
        }
        // >5000 chars distinguishes real page data from a challenge/error shell.
        // But the tag is STREAMING: it can be in the DOM and already past 5000
        // chars while its text is still arriving, which yields "Unterminated
        // string in JSON at position N". Parsing IS the readiness test — keep
        // polling until it succeeds rather than trusting length or readyState.
        if (el && el.textContent.length > 5000) {
          try {
            return JSON.parse(el.textContent);
          } catch {
            /* still streaming — poll again */
          }
        }
      }
      return null;
    } finally {
      f.src = "about:blank";
      f.remove();
    }
  }

  const rows = [];
  const seen = new Set();
  let pages = 0,
    err = null;
  try {
    for (let p = 1; p <= 25; p++) {
      const nd = await readPage(`/sale/?${QS}&page=${p}`);
      if (!nd) {
        err = `page ${p}: no __NEXT_DATA__ (WAF?)`;
        break;
      }
      const cp = nd.props?.pageProps?.componentProps ?? {};
      const map = cp.listingsMap ?? {};
      const ids = Object.keys(map);
      if (!ids.length) break;
      pages = p;
      for (const k of ids) {
        const m = map[k].listingModel ?? {};
        if (!m.url || seen.has(m.url)) continue;
        seen.add(m.url);
        const a = m.address ?? {},
          ft = m.features ?? {};
        rows.push([
          m.url,
          m.price ?? "",
          m.tags?.tagText ?? "",
          ft.beds ?? null,
          ft.baths ?? null,
          ft.parking ?? null,
          ft.landSize ?? null,
          a.street ?? "",
          a.suburb ?? "",
          a.postcode ?? "",
          a.state ?? "",
          a.lat ?? null,
          a.lng ?? null,
          m.inspection?.openTime ?? null,
          ft.propertyTypeFormatted ?? "",
          base(m.images?.[0]),
        ]);
      }
      await sleep(1300); // search pages tolerate this; listing pages do NOT
    }
  } catch (e) {
    err = String(e);
  }

  const enc = encodeURIComponent(JSON.stringify({ pages, err, rows }));
  location.href = "http://127.0.0.1:3300/#MOMD=" + enc;
  return { pages, listings: rows.length, err, encodedKB: Math.round(enc.length / 1024) };
})();
