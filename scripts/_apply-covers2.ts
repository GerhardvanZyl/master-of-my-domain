import Database from "better-sqlite3";
import fs from "node:fs";

// hero_og2.json: { ext: [coverListingId, coverPhotoIndex], ... }  (skips "DENIED")
const og = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Record<string, [string, string] | string>;
const db = new Database("data/app.db");
const now = new Date().toISOString();

const setHero = db.transaction((pid: number, imageId: string) => {
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
for (const [ext, v] of Object.entries(og)) {
  if (typeof v === "string") continue; // DENIED
  const [clid, cpi] = v;
  const prop = db.prepare("SELECT id FROM properties WHERE external_id=?").get(ext) as { id: number } | undefined;
  if (!prop) { unmatched.push({ ext, reason: "no property" }); continue; }
  const prefix = `${clid}_${cpi}_`;
  const imgs = db
    .prepare("SELECT id, source_url FROM images WHERE property_id=?")
    .all(prop.id) as { id: string; source_url: string }[];
  const hit = imgs.find((i) => (i.source_url.split("/").pop() ?? "").startsWith(prefix));
  if (hit) { setHero(prop.id, hit.id); matched++; }
  else unmatched.push({ ext, pid: prop.id, wanted: prefix, imgCount: imgs.length });
}
console.log(JSON.stringify({ total: Object.keys(og).length, matched, unmatchedCount: unmatched.length, unmatched }, null, 1));
