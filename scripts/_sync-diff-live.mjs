// Diff today's search feed against the LIVE app's current state.
//
// Replaces _sync-diff.mjs's "load locally, then diff the local DB" flow: the
// local data/app.db is deliberately never written (see the batch-push rule), so
// it sits a full round behind and every row the previous round added shows up as
// NEW again. The baseline here comes from scripts/_snapshot-live.mjs instead, so
// the diff is against what the live app actually holds.
//
// Emits data/harvest/_diff.json in exactly the shape _pass-targets.mjs expects.
import fs from "node:fs";

const snap = JSON.parse(fs.readFileSync("data/harvest/_snapshot.json", "utf8"));
const feed = JSON.parse(fs.readFileSync("data/harvest/feed-items.json", "utf8"));
const raw = JSON.parse(fs.readFileSync("data/harvest/feed.json", "utf8"));

// The app keeps a non-property config row (vibeConfig) in `properties`; it has no
// listing_url and must never be diffed, passed or marked withdrawn.
// (its listing_url is a timestamp, not a URL, so a truthiness check is not enough)
snap.rows = snap.rows.filter((r) => /^https?:\/\//.test(r.listing_url || ""));

const norm = (u) => (u || "").replace(/\/+$/, "").toLowerCase();
const prev = new Map(snap.rows.map((r) => [norm(r.listing_url), r]));
// MISSING must be judged against the RAW feed, not the h&l-filtered items: a
// house-and-land listing is still live on Domain, we just refuse to load it. Using
// the filtered list marks every one of them withdrawn on every run.
const stillOnDomain = new Set(raw.rows.map((r) => norm("https://www.domain.com.au" + r[0])));
const inFeed = new Map(feed.map((i) => [norm(i.listingUrl), i]));

// The suburb filter is ESSENTIAL. The live baseline is already VIC-only (the
// home grid excludes NSW), but keep it explicit so a future baseline change
// can't sweep the 25 frozen Sydney rows in as "missing".
const isTarget = (u) =>
  /(point-cook-vic-3030|williams-landing-vic-3027|torquay-vic-3228|seabrook-vic-3028)/.test(u || "");

const neu = feed
  .filter((i) => !prev.has(norm(i.listingUrl)))
  .map((i) => ({
    external_id: i.externalId,
    listing_url: i.listingUrl,
    address: i.address,
    suburb: i.suburb,
    price_display: i.priceDisplay,
  }));

const changed = feed
  .filter((i) => {
    const p = prev.get(norm(i.listingUrl));
    return p && (p.price_display || "") !== (i.priceDisplay || "");
  })
  .map((i) => {
    const p = prev.get(norm(i.listingUrl));
    return {
      external_id: i.externalId,
      listing_url: i.listingUrl,
      address: i.address,
      price_display: i.priceDisplay,
      price_numeric: i.priceNumeric,
      was: p.price_display,
      was_numeric: p.price_numeric,
    };
  });

// Gone from the feed and not already recorded as sold/withdrawn/delisted.
const missing = snap.rows.filter(
  (r) => !stillOnDomain.has(norm(r.listing_url)) && isTarget(r.listing_url) && !r.delisted,
);

const noImages = snap.rows.filter((r) => !r.image_count && !r.delisted);

fs.writeFileSync(
  "data/harvest/_diff.json",
  JSON.stringify({ marker: snap.marker, base: snap.base, neu, changed, missing, noImages }, null, 1),
);

console.log("baseline", snap.base, snap.rows.length, "rows @", snap.marker);
console.log("feed items (completed homes)", feed.length);
console.log("NEW", neu.length);
console.log("PRICE-TEXT CHANGED", changed.length);
console.log("MISSING FROM FEED (target suburbs, not already delisted)", missing.length);
console.log("PROPERTIES WITH NO IMAGES", noImages.length);
console.log("\nnew:");
for (const r of neu) console.log(" ", r.external_id, r.address, "|", r.price_display);
console.log("\nchanged:");
for (const r of changed) console.log("  ", r.address, "|", JSON.stringify(r.was), "->", JSON.stringify(r.price_display));
console.log("\nmissing (candidates for sold/withdrawn):");
for (const r of missing) console.log(" ", r.external_id, r.address, "|", r.price_display);
