/**
 * Apply exact Domain covers from a search-feed harvest.
 *
 * The search feed's `listingModel.images[0]` IS the listing's og:image cover —
 * verified byte-for-byte against og:image on 4 listings, including one whose
 * cover is photoIndex 17. So no per-listing page fetch (and no WAF grind) is
 * needed to get exact heroes. Match is on the full CDN basename, falling back
 * to the `<listingId>_<photoIndex>_` prefix if the crop/date changed.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const SP =
  "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/771da963-4458-4b1d-b024-700d25a0a9dc/scratchpad";
const feed = JSON.parse(fs.readFileSync(SP + "/feed.json", "utf8")) as {
  id: number;
  imgs: string[];
}[];

const db = new Database("data/app.db");
const now = new Date().toISOString();

const setHero = db.transaction((pid: string, imageId: string) => {
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
  prefix = 0;
const missing: unknown[] = [];
for (const f of feed) {
  const cover = f.imgs?.[0];
  if (!cover) continue;
  const prop = db
    .prepare("SELECT id, address FROM properties WHERE external_id=?")
    .get(String(f.id)) as { id: string; address: string } | undefined;
  if (!prop) continue;
  const imgs = db
    .prepare("SELECT id, source_url FROM images WHERE property_id=?")
    .all(prop.id) as { id: string; source_url: string }[];
  const base = (u: string) => u.split("/").pop() ?? "";
  let hit = imgs.find((i) => base(i.source_url) === cover);
  if (hit) exact++;
  else {
    const pfx = cover.split("_").slice(0, 2).join("_") + "_";
    hit = imgs.find((i) => base(i.source_url).startsWith(pfx));
    if (hit) prefix++;
  }
  if (hit) setHero(prop.id, hit.id);
  else missing.push({ ext: f.id, address: prop.address, cover, imgCount: imgs.length });
}
console.log(
  JSON.stringify({ feed: feed.length, exact, prefix, missingCount: missing.length, missing }, null, 1),
);
