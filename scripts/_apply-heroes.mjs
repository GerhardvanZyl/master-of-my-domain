// Set every property's hero to Domain's OWN cover photo.
//
// The search feed's listingModel.images[0] IS the listing's og:image cover —
// verified byte-for-byte, including one listing whose cover sits at photoIndex
// 17, so this is not the "first photo" heuristic in disguise. That means exact
// heroes with zero listing-page fetches and zero WAF risk.
//
// Reads data/harvest/feed.json (the search harvest), not a per-session path.
// Re-runnable: clears the property's prior hero before setting the new one.
//
// Usage: node scripts/_apply-heroes.mjs [--dry-run]
import fs from "node:fs";
import Database from "better-sqlite3";

const dry = process.argv.includes("--dry-run");
const { rows } = JSON.parse(fs.readFileSync("data/harvest/feed.json", "utf8"));
const db = new Database("data/app.db");
const now = new Date().toISOString();
const base = (u) => (u || "").split("/").pop().split("?")[0];

const propOf = db.prepare("SELECT id, address FROM properties WHERE external_id = ?");
const imgsOf = db.prepare("SELECT id, source_url FROM images WHERE property_id = ?");

const setHero = db.transaction((pid, imageId) => {
  db.prepare(
    "UPDATE image_tags SET notes=NULL WHERE notes='hero' AND image_id IN (SELECT id FROM images WHERE property_id=?)",
  ).run(pid);
  const has = db.prepare("SELECT 1 FROM image_tags WHERE image_id=?").get(imageId);
  if (has)
    db.prepare(
      "UPDATE image_tags SET notes='hero', tagged_by='domain-cover', tagged_at=? WHERE image_id=?",
    ).run(now, imageId);
  else
    db.prepare(
      "INSERT INTO image_tags (image_id, notes, tagged_by, tagged_at) VALUES (?, 'hero', 'domain-cover', ?)",
    ).run(imageId, now);
});

let exact = 0,
  prefix = 0,
  noImages = 0,
  noProp = 0;
const missing = [];

for (const r of rows) {
  const url = r[0],
    cover = r[15];
  const ext = (/-(\d+)$/.exec(url) || [])[1];
  if (!ext || !cover) continue;
  const prop = propOf.get(ext);
  if (!prop) {
    noProp++;
    continue;
  }
  const imgs = imgsOf.all(prop.id);
  if (!imgs.length) {
    noImages++;
    continue;
  }
  let hit = imgs.find((i) => base(i.source_url) === cover);
  if (hit) exact++;
  else {
    // Relisted properties' covers carry a DIFFERENT listingId than our
    // external_id, and crops/dates change — the <listingId>_<photoIndex>_
    // prefix survives both.
    const pfx = cover.split("_").slice(0, 2).join("_") + "_";
    hit = imgs.find((i) => base(i.source_url).startsWith(pfx));
    if (hit) prefix++;
  }
  if (hit) {
    if (!dry) setHero(prop.id, hit.id);
  } else missing.push({ ext, address: prop.address, cover, imgCount: imgs.length });
}

console.log(
  JSON.stringify(
    {
      dryRun: dry,
      feedRows: rows.length,
      exactCover: exact,
      prefixFallback: prefix,
      propertyHasNoImages: noImages,
      notInDb: noProp,
      noMatch: missing.length,
    },
    null,
    1,
  ),
);
for (const m of missing.slice(0, 20)) console.log("  no match:", m.address, "|", m.cover, `(${m.imgCount} imgs)`);
