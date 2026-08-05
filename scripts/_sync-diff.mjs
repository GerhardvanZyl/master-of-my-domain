import fs from "node:fs";
import Database from "better-sqlite3";
const SP = "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/19013346-0c19-42ad-8751-34b894429247/scratchpad";
const db = new Database("data/app.db");
const { marker, rows } = JSON.parse(fs.readFileSync(SP + "/snapshot.json", "utf8"));
const prev = new Map(rows.map((r) => [r.listing_url, r]));

const now = db.prepare(
  "SELECT id, external_id, listing_url, address, suburb, price_display, price_numeric, next_inspection, created_at, updated_at FROM properties",
).all();

const isTarget = (u) => /(point-cook-vic-3030|williams-landing-vic-3027|torquay-vic-3228)/.test(u || "");

const neu = now.filter((r) => !prev.has(r.listing_url));
const changed = now.filter((r) => {
  const p = prev.get(r.listing_url);
  return p && (p.price_display || "") !== (r.price_display || "");
});
// seen-in-feed == updated_at >= marker
const missing = now.filter(
  (r) => prev.has(r.listing_url) && r.updated_at < marker && isTarget(r.listing_url),
);
const noImages = db.prepare(
  "SELECT id, listing_url, address, suburb FROM properties WHERE id NOT IN (SELECT DISTINCT property_id FROM images)",
).all();

console.log("marker", marker);
console.log("total properties", now.length);
console.log("NEW", neu.length);
console.log("PRICE-TEXT CHANGED", changed.length);
console.log("MISSING FROM FEED (target suburbs)", missing.length);
console.log("PROPERTIES WITH NO IMAGES", noImages.length);
console.log("\nnew by suburb:", JSON.stringify(neu.reduce((a, r) => ((a[r.suburb] = (a[r.suburb] || 0) + 1), a), {})));
console.log("no-images by suburb:", JSON.stringify(noImages.reduce((a, r) => ((a[r.suburb] = (a[r.suburb] || 0) + 1), a), {})));

fs.writeFileSync(SP + "/diff.json", JSON.stringify({ marker, neu, changed, missing, noImages }, null, 1));
console.log("\nsample changed:");
for (const r of changed.slice(0, 12))
  console.log(" ", r.address, "|", JSON.stringify(prev.get(r.listing_url).price_display), "->", JSON.stringify(r.price_display));
console.log("\nmissing (candidates for sold/withdrawn):");
for (const r of missing) console.log(" ", r.external_id, r.address, r.suburb, "|", r.price_display);
