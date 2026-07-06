// Runs in the PAGE context (world: MAIN) so it can read the window globals that
// realestate.com.au stashes listing state on. Extracts embedded JSON + image
// srcs and hands them to the isolated content script via postMessage.
//
// Capture is pinned to the URL that was loaded: this content script does NOT
// re-run on Next.js soft navigation, and #__NEXT_DATA__ is not refreshed on soft
// nav — so sending only for INITIAL_URL avoids pairing a soft-navigated URL with
// stale embedded data. We DO re-send for the same listing as lazily-loaded
// carousel images appear (server upserts by URL and appends new images).
(function () {
  const LISTING_RE = {
    "www.domain.com.au": /-\d{6,}\/?$/,
    "www.realestate.com.au": /\/property-/,
  };

  function isListing() {
    const re = LISTING_RE[location.hostname];
    return re ? re.test(location.pathname) : false;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function collect() {
    const nextEl = document.getElementById("__NEXT_DATA__");
    const nextData = nextEl ? parseJson(nextEl.textContent || "") : null;
    const jsonLd = [];
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((s) => {
        const v = parseJson(s.textContent || "");
        if (Array.isArray(v)) jsonLd.push(...v);
        else if (v) jsonLd.push(v);
      });
    const globals =
      window.__INITIAL_STATE__ || window.ArgonautExchange || window.REA || null;
    const imgUrls = [...new Set([...document.images].map((i) => i.src))];
    const og = document.querySelector('meta[property="og:title"]');
    return {
      url: location.href,
      nextData,
      jsonLd,
      globals,
      imgUrls,
      title: document.title,
      ogTitle: og ? og.getAttribute("content") : undefined,
    };
  }

  const INITIAL_URL = location.href;
  let lastImgCount = -1;

  function send() {
    if (location.href !== INITIAL_URL || !isListing()) return;
    const payload = collect();
    // Send on first capture, then again only when the gallery has grown — tops
    // up on-demand carousel images without spamming identical POSTs.
    if (payload.imgUrls.length === lastImgCount) return;
    lastImgCount = payload.imgUrls.length;
    let json;
    try {
      json = JSON.stringify(payload);
    } catch {
      // Some site globals are circular/non-serializable — drop them.
      payload.globals = null;
      try {
        json = JSON.stringify(payload);
      } catch {
        return;
      }
    }
    window.postMessage({ source: "momd-collect", json }, "*");
  }

  // Initial capture once the page has settled.
  setTimeout(send, 800);

  // Re-capture for the SAME listing as lazily-loaded carousel images appear.
  // Debounced so we parse embedded JSON at most ~once per 600ms, not on every
  // DOM mutation. ponytail: MutationObserver over a forever timer — fires only
  // when the DOM actually changes.
  let debounce = null;
  new MutationObserver(() => {
    if (location.href !== INITIAL_URL) return;
    clearTimeout(debounce);
    debounce = setTimeout(send, 600);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
