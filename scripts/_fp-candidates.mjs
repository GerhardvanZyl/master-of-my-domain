// Shortlist floorplan candidates among recently-added photos, for Claude to Read
// and confirm. Floorplans must end up tagged notes='floorplan': pickFloorplan's
// shape rule (aspect < 0.92, or 1.37-1.46) misses them at 4:3, 1.29, 1.47 and
// even 3:2, and an explicit note beats the heuristic.
//
// High recall on purpose — it is cheap to Read a few extra photos and expensive
// to ship a property with an invisible floorplan. Two signals:
//   * the local model tagged it `other` (its label for plans/diagrams), or
//   * it is among the last 3 in the gallery (Domain puts the floorplan LAST).
//
// Usage: node scripts/_fp-candidates.mjs [--since=<ISO>]
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const since = sinceArg ? sinceArg.slice(8) : new Date(Date.now() - 864e5).toISOString();
const db = new Database("data/app.db", { readonly: true });

const props = db
  .prepare(
    `SELECT DISTINCT p.id, p.address, p.suburb
       FROM properties p JOIN images i ON i.property_id = p.id
      WHERE i.created_at >= ?`,
  )
  .all(since);

const imgsOf = db.prepare(
  `SELECT i.id, i.local_path lp, i.ordinal, i.width w, i.height h, t.room_type rt, t.notes
     FROM images i LEFT JOIN image_tags t ON t.image_id = i.id
    WHERE i.property_id = ? ORDER BY i.ordinal`,
);

const out = [];
let already = 0;
for (const p of props) {
  const imgs = imgsOf.all(p.id);
  if (imgs.some((i) => i.notes === "floorplan")) {
    already++;
    continue;
  }
  const lastThree = new Set(imgs.slice(-3).map((i) => i.id));
  for (const i of imgs) {
    if (i.rt === "other" || lastThree.has(i.id)) {
      out.push({
        imageId: i.id,
        propertyId: p.id,
        address: `${p.address}`,
        ordinal: i.ordinal,
        room: i.rt,
        aspect: i.w && i.h ? +(i.w / i.h).toFixed(2) : null,
        absPath: path.resolve("data", i.lp),
      });
    }
  }
}

fs.writeFileSync("data/harvest/_fp-candidates.json", JSON.stringify(out, null, 1));
console.log(
  JSON.stringify({
    since,
    properties: props.length,
    alreadyHaveFloorplan: already,
    candidates: out.length,
  }),
);
for (const c of out) console.log(`  ${c.address} #${c.ordinal} ${c.room} a=${c.aspect} ${c.imageId}`);
