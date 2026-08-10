import fs from "node:fs";
import Database from "better-sqlite3";

// Bridge payload {batch, res:[[listingUrl, imageUrls|null, status]]} -> load:images input.
//
// Domain RE-SIGNS every image URL per capture, so source_url can't detect "already
// have this photo" and syncImages would happily store the whole gallery twice. The
// basename (`<listingId>_<photoIndex>_<uploadedAt>-wW-hH`) IS stable, so we drop any
// URL whose basename is already on disk for that property. That makes re-harvesting
// a listing that already has photos safe — which is the whole point when we're
// re-fetching just to pick up a floorplan galleryV2 omitted.
//
// Usage: node scripts/_gallery-load.mjs data/harvest/gallery.json
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/_gallery-load.mjs <payload.json>");
  process.exit(1);
}
const { batch, res } = JSON.parse(fs.readFileSync(src, "utf8"));
const db = new Database("data/app.db");
const propOf = db.prepare("SELECT id FROM properties WHERE listing_url = ?");
const haveOf = db.prepare("SELECT source_url FROM images WHERE property_id = ?");

const base = (u) => u.split("/").pop().split("?")[0];

const items = [];
for (const [listingUrl, imageUrls, status] of res) {
  const prop = propOf.get(listingUrl);
  if (!prop) {
    console.log("  ??", "no property row for", listingUrl);
    continue;
  }
  const have = new Set(haveOf.all(prop.id).map((r) => base(r.source_url)));
  const fresh = (imageUrls ?? []).filter((u) => !have.has(base(u)));
  const n = imageUrls ? imageUrls.length : 0;
  console.log(
    `${String(n).padStart(3)} found ${String(fresh.length).padStart(3)} new  ${status ?? "-"}  ${listingUrl.split("/").pop()}`,
  );
  if (fresh.length) items.push({ listingUrl, imageUrls: fresh });
}
const out = `data/harvest/gallery-load-${batch}.json`;
fs.writeFileSync(out, JSON.stringify(items, null, 1));
console.log(
  `\n${items.length}/${res.length} listings need a load, ${items.reduce((a, i) => a + i.imageUrls.length, 0)} new photos -> ${out}`,
);
