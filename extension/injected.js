// Runs in the PAGE context (world: MAIN) so it can read the window globals that
// realestate.com.au stashes listing state on. Extracts embedded JSON + image
// srcs and hands them to the isolated content script via postMessage.
// Auto-fires on listing-detail pages, re-firing on SPA navigation (Domain is a
// Next.js SPA that swaps listings without a full reload).
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

  let lastUrl = null;
  function maybeSend() {
    if (!isListing() || location.href === lastUrl) return;
    lastUrl = location.href;
    // Let SPA content settle before reading embedded JSON.
    setTimeout(() => {
      const payload = collect();
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
    }, 800);
  }

  maybeSend();
  // ponytail: 1s href poll covers SPA nav on both sites; swap for a History API
  // hook only if it feels laggy.
  setInterval(maybeSend, 1000);
})();
