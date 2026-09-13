// REA SEARCH harvest — paste as ONE javascript_tool call on a
// www.realestate.com.au tab, then poll window.__REA until done:true.
//
// Unlike Domain, a same-origin fetch() of an REA search page is NOT bot-walled
// (verified 2026-09-06: HTTP 200, ~1.2MB of real server HTML with the cards in
// it), so no iframe trick is needed here — plain fetch + DOMParser.
//
// NOTE: an async IIFE returns {} through this harness, so this parks its result
// on window.__REA and you read it back with a second, synchronous call.
//
// Cards are `.residential-card` (there is no data-testid). innerText is empty in
// a DOMParser document — read textContent.
window.__REA = { rows: [], sold: [], perSuburb: {}, done: false, err: null, at: null };
(async () => {
  const S = window.__REA;
  const SUBURBS = [
    "point+cook,+vic+3030",
    "williams+landing,+vic+3027",
    "seabrook,+vic+3028",
    "torquay,+vic+3228",
  ];
  const MAX_BUY_PAGES = 16;
  const MAX_SOLD_PAGES = 3;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  function cards(html) {
    const d = new DOMParser().parseFromString(html, "text/html");
    return [...d.querySelectorAll(".residential-card")]
      .map((c) => {
        const a = c.querySelector('a[href*="/property-"]');
        if (!a) return null;
        const href = a.getAttribute("href");
        const url = href.startsWith("http") ? href : "https://www.realestate.com.au" + href;
        const id = (url.match(/-(\d+)(?:[?#]|$)/) || [])[1] || null;
        return {
          url,
          id,
          labels: [...c.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")),
          text: norm(c.textContent).slice(0, 300),
        };
      })
      .filter(Boolean);
  }

  async function page(url) {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
    return cards(await r.text());
  }

  try {
    for (const sub of SUBURBS) {
      let n = 0;
      const seen = new Set();
      for (let p = 1; p <= MAX_BUY_PAGES; p++) {
        const got = await page(
          `https://www.realestate.com.au/buy/with-3-bedrooms-between-600000-1100000-in-${sub}` +
            `/list-${p}?activeSort=list-date&includeSurrounding=false`,
        );
        const fresh = got.filter((r) => r.id && !seen.has(r.id));
        fresh.forEach((r) => seen.add(r.id));
        S.rows.push(...fresh.map((r) => ({ ...r, sub })));
        n = p;
        S.perSuburb[sub] = n;
        S.at = sub + " buy p" + p + " +" + fresh.length;
        if (fresh.length === 0) break;
        await sleep(1300);
      }
      for (let p = 1; p <= MAX_SOLD_PAGES; p++) {
        const got = await page(
          `https://www.realestate.com.au/sold/in-${sub}/list-${p}` +
            `?activeSort=solddate&includeSurrounding=false`,
        );
        S.sold.push(...got.map((r) => ({ ...r, sub })));
        S.at = sub + " sold p" + p + " +" + got.length;
        if (got.length === 0) break;
        await sleep(1300);
      }
    }
  } catch (e) {
    S.err = String(e && e.message ? e.message : e);
  }
  S.done = true;
  // Hand the payload to the local receiver: 127.0.0.1 never prompts for JS, and
  // a cross-origin POST from here is blocked by Private Network Access.
  // Gzip+base64 first — ~400 raw cards is ~150KB of JSON and percent-encoding it
  // pushes a hash-bridge navigation past what Chrome will carry. It compresses ~8x.
  const json = JSON.stringify({ rows: S.rows, sold: S.sold, perSuburb: S.perSuburb, err: S.err });
  const gz = new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
  );
  const bytes = new Uint8Array(await gz.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  S.gzB64Len = bin.length;
  // `#name=<file>&d=` is the only form the receiver's landing page posts; the
  // old `#MOMDGZ=` fragment reaches it as "no payload" and the harvest is lost.
  location.href = "http://127.0.0.1:3300/#name=rea-search-gz&d=" + encodeURIComponent(btoa(bin));
})();
