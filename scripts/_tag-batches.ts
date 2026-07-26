import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
const OUT = process.argv[2];
const PER = Number(process.argv[3] || 120);
const DATA = path.resolve("data");
const db = new Database("data/app.db");
// Every image lacking a room_type (includes hero/notes-only rows that need a room).
const imgs = db.prepare(
  `SELECT i.id AS imageId, i.property_id AS propertyId, p.address AS address, i.local_path AS localPath
   FROM images i JOIN properties p ON p.id=i.property_id
   LEFT JOIN image_tags t ON t.image_id=i.id
   WHERE t.room_type IS NULL
   ORDER BY i.property_id, i.ordinal`,
).all() as { imageId: string; propertyId: string; address: string | null; localPath: string }[];
const byProp = new Map<string, typeof imgs>();
for (const i of imgs) (byProp.get(i.propertyId) ?? byProp.set(i.propertyId, []).get(i.propertyId)!).push(i);
const batches: typeof imgs[] = [];
let cur: typeof imgs = [];
for (const [, list] of byProp) {
  if (cur.length && cur.length + list.length > PER) { batches.push(cur); cur = []; }
  cur.push(...list);
}
if (cur.length) batches.push(cur);
fs.mkdirSync(OUT, { recursive: true });
batches.forEach((b, k) => {
  fs.writeFileSync(`${OUT}/batch-${String(k).padStart(3, "0")}.json`,
    JSON.stringify(b.map((i) => ({ imageId: i.imageId, absPath: path.resolve(DATA, i.localPath) })), null, 0));
});
console.log(JSON.stringify({ totalNeedingRoom: imgs.length, properties: byProp.size, batches: batches.length }));
