import Database from "better-sqlite3";
import fs from "node:fs";

// Apply Domain's actual cover (from og:image) as the hero for each property.
// covers.json: [[propertyId, coverListingId, coverPhotoIndex], ...]
const covers = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as [string, string, number][];
const db = new Database("data/app.db");
const now = new Date().toISOString();

const setHero = db.transaction((pid: string, imageId: string) => {
  db.prepare(
    "UPDATE image_tags SET notes=NULL WHERE notes='hero' AND image_id IN (SELECT id FROM images WHERE property_id=?)",
  ).run(pid);
  const has = db.prepare("SELECT 1 FROM image_tags WHERE image_id=?").get(imageId);
  if (has) db.prepare("UPDATE image_tags SET notes='hero' WHERE image_id=?").run(imageId);
  else
    db.prepare(
      "INSERT INTO image_tags (image_id, notes, tagged_by, tagged_at) VALUES (?, 'hero', 'domain-cover', ?)",
    ).run(imageId, now);
});

let matched = 0;
const unmatched: any[] = [];
for (const [pid, clid, cpi] of covers) {
  const prefix = `${clid}_${cpi}_`;
  const imgs = db
    .prepare("SELECT id, source_url FROM images WHERE property_id=?")
    .all(pid) as { id: string; source_url: string }[];
  const hit = imgs.find((i) => (i.source_url.split("/").pop() ?? "").startsWith(prefix));
  if (hit) {
    setHero(pid, hit.id);
    matched++;
  } else {
    unmatched.push({ pid, wanted: prefix, hasProperty: imgs.length > 0, imgCount: imgs.length });
  }
}
console.log(JSON.stringify({ total: covers.length, matched, unmatchedCount: unmatched.length, unmatched }, null, 1));
