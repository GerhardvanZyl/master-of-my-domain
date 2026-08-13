// Load galleries from the diagnostic pass, using the CORRECT trust rule:
//
//   galleryV2  -> trust wholesale. It IS this listing's gallery, whatever
//                 listingId the filenames carry. A RELISTED property keeps the
//                 previous listing's photo ids (8 Lure Ave: 10 photos all
//                 prefixed 2020487905_, only the floorplan carries its own
//                 2021060701_), so filtering these by external_id throws the
//                 whole gallery away.
//   page HTML  -> filter hard. It contains a "similar listings" carousel of
//                 other properties' covers plus agency logos/banners. Accept a
//                 basename only if it starts with external_id or with a
//                 listingId that galleryV2 itself vouched for.
import fs from "node:fs";
import Database from "better-sqlite3";

const raw = JSON.parse(fs.readFileSync("data/harvest/diag.json", "utf8"));
const db = new Database("data/app.db", { readonly: true });
const propOf = db.prepare("SELECT id FROM properties WHERE listing_url = ?");
const haveOf = db.prepare("SELECT source_url FROM images WHERE property_id = ?");
const base = (u) => u.split("/").pop().split("?")[0];
const idOf = (b) => (/^(\d+)_/.exec(b) || [])[1];

const items = [];
for (const [key, v] of Object.entries(raw)) {
  const listingUrl = "https://www.domain.com.au" + key;
  const prop = propOf.get(listingUrl);
  if (!prop || !v.gal?.length) continue;
  const have = new Set(haveOf.all(prop.id).map((r) => base(r.source_url)));
  const fresh = v.gal.filter((u) => !have.has(base(u)));
  const ids = new Set(v.gal.map((u) => idOf(base(u))).filter(Boolean));
  console.log(
    `${key.split("/").pop()}: gallery=${v.gal.length} new=${fresh.length} listingIds=${[...ids].join(",")}`,
  );
  if (fresh.length) items.push({ listingUrl, imageUrls: fresh });
}
fs.writeFileSync("data/harvest/_gallery-diag.json", JSON.stringify(items, null, 1));
console.log(`\n-> ${items.reduce((a, i) => a + i.imageUrls.length, 0)} photos for ${items.length} listings`);
