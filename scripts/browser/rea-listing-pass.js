// REA per-listing pass — paste as ONE javascript_tool call on a
// www.realestate.com.au tab. Replace URLS with this round's list.
//
// Produces one RawPageData-shaped record per listing, exactly the shape
// ReaAdapter.normalize() reads (src/scrape/adapters/rea.ts), so the round can
// run captures through the same adapter the extension feeds.
//
// Two things worth knowing before touching this:
//
// 1. The gallery is lazy in the DOM — only ~4 images load until the viewer is
//    opened — but the FULL gallery is in the server HTML as GraphQL
//    `MediaImage` / `MediaFloorplan` nodes carrying a `{size}`-templated CDN
//    URL. So a plain same-origin fetch beats driving the page, and REA does not
//    bot-wall a same-origin fetch the way Domain does.
//
// 2. `MediaFloorplan` is a distinct __typename. REA puts its floorplan anywhere
//    in the reel and its alt text does not say, which is why the tagger refuses
//    to guess one — but the page states it outright, so the floorplan note can
//    be set from the capture rather than inferred.
window.__PASS = { out: [], errs: [], at: null, done: false };
(async () => {
  const S = window.__PASS;
  const URLS = [];
  const SIZE = "1650x1100-format=webp"; // no -crop: cropping mangles a floorplan
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const media = (unescaped) => {
    const re = /"__typename":"(MediaImage|MediaFloorplan)","id":"([0-9a-f]{32,})","templatedUrl":"([^"]+)"/g;
    const seen = new Map();
    for (const m of unescaped.matchAll(re)) if (!seen.has(m[2])) seen.set(m[2], { type: m[1], url: m[3] });
    const imgUrls = [];
    const floorplanUrls = [];
    for (const v of seen.values())
      (v.type === "MediaFloorplan" ? floorplanUrls : imgUrls).push(v.url.replace("{size}", SIZE));
    return { imgUrls, floorplanUrls };
  };

  for (const url of URLS) {
    try {
      const html = await fetch(url, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      });
      const d = new DOMParser().parseFromString(html, "text/html");
      const meta = (p) => d.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content ?? null;
      const jsonLd = [...d.querySelectorAll('script[type="application/ld+json"]')]
        .map((s) => {
          try {
            return JSON.parse(s.textContent);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .flatMap((v) => (Array.isArray(v) ? v : [v]));
      const { imgUrls, floorplanUrls } = media(html.replace(/\\u002F/g, "/").replace(/\\+"/g, '"'));
      S.out.push({
        url,
        nextData: null,
        jsonLd,
        globals: null,
        title: d.title || null,
        ogTitle: meta("og:title"),
        ogDescription: meta("og:description"),
        ogImage: meta("og:image"),
        // textContent, not innerText — this document is detached, so innerText
        // is empty. That means <style>/<script> text counts too, and REA opens
        // with several KB of inline CSS: without this strip the whole 8000-char
        // budget is spent before the price is reached and every listing
        // normalizes as "no price".
        bodyText: (() => {
          d.querySelectorAll("script, style, noscript, template").forEach((e) => e.remove());
          return (d.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 8000);
        })(),
        ariaLabels: [...d.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")),
        imgUrls: [...imgUrls, ...floorplanUrls],
        floorplanUrls,
        imgAlts: [],
      });
      S.at = url.split("-").pop() + " ok " + imgUrls.length + "+" + floorplanUrls.length;
    } catch (e) {
      S.errs.push({ url, err: String(e && e.message ? e.message : e) });
      S.at = url.split("-").pop() + " ERR";
    }
    await sleep(3000);
  }
  S.done = true;
  const json = JSON.stringify({ out: S.out, errs: S.errs });
  const gz = new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")));
  const bytes = new Uint8Array(await gz.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  // The receiver's landing page strips the fragment and posts it for us, so the
  // payload never shows up in tool output — an echoed 300KB hash costs more
  // context than the harvest it carries.
  location.href = "http://127.0.0.1:3300/#name=rea-pass-gz&d=" + encodeURIComponent(btoa(bin));
})();
