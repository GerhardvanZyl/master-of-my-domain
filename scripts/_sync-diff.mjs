// Diff the DB against the pre-sync snapshot. Run AFTER `npm run load` of the
// feed items. Paths are fixed under data/harvest/ on purpose — earlier versions
// hardcoded a per-session scratchpad path, which made them useless on the next run.
import fs from "node:fs";
import Database from "better-sqlite3";

const db = new Database("data/app.db", { readonly: true });
const { marker, rows } = JSON.parse(fs.readFileSync("data/harvest/_snapshot.json", "utf8"));
const prev = new Map(rows.map((r) => [r.listing_url, r]));

const now = db
  .prepare(
    "SELECT id, external_id, listing_url, address, suburb, price_display, price_numeric, next_inspection, created_at, updated_at FROM properties",
  )
  .all();

// The suburb filter is ESSENTIAL: without it the 25 frozen NSW/Sydney rows —
// which are not part of this search and must never be touched — show up as
// "missing from feed" on every single run.
const isTarget = (u) =>
  /(point-cook-vic-3030|williams-landing-vic-3027|torquay-vic-3228|seabrook-vic-3028)/.test(u || "");
const delisted = new Set(
  db
    .prepare("SELECT url FROM scrape_jobs WHERE status IN ('delisted','sold','withdrawn')")
    .all()
    .map((r) => r.url),
);

const neu = now.filter((r) => !prev.has(r.listing_url));
const changed = now
  .filter((r) => {
    const p = prev.get(r.listing_url);
    return p && (p.price_display || "") !== (r.price_display || "");
  })
  .map((r) => ({ ...r, was: prev.get(r.listing_url).price_display }));
// Seen-in-feed == updated_at >= marker, because the load touches every row it saw.
const missing = now.filter(
  (r) =>
    prev.has(r.listing_url) &&
    r.updated_at < marker &&
    isTarget(r.listing_url) &&
    !delisted.has(r.listing_url),
);
const noImages = db
  .prepare(
    "SELECT id, external_id, listing_url, address, suburb FROM properties WHERE id NOT IN (SELECT DISTINCT property_id FROM images)",
  )
  .all();

fs.writeFileSync(
  "data/harvest/_diff.json",
  JSON.stringify({ marker, neu, changed, missing, noImages }, null, 1),
);

console.log("marker", marker);
console.log("total properties", now.length);
console.log("NEW", neu.length);
console.log("PRICE-TEXT CHANGED", changed.length);
console.log("MISSING FROM FEED (target suburbs, not already delisted)", missing.length);
console.log("PROPERTIES WITH NO IMAGES", noImages.length);
console.log("\nnew:");
for (const r of neu) console.log(" ", r.external_id, r.address, r.suburb, "|", r.price_display);
console.log("\nchanged:");
for (const r of changed.slice(0, 40))
  console.log("  ", r.address, "|", JSON.stringify(r.was), "->", JSON.stringify(r.price_display));
console.log("\nmissing (candidates for sold/withdrawn):");
for (const r of missing) console.log(" ", r.external_id, r.address, r.suburb, "|", r.price_display);
