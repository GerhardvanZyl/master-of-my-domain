import Database from "better-sqlite3";

/**
 * Mark one image as a property's hero (the card/detail lead photo), overriding
 * the aspect-ratio heuristic — used to skip aerials/floorplans that are shaped
 * like a normal 3:2 photo. Stored as image_tags.notes='hero'. Idempotent; only
 * one hero per property (a new pick clears the old). Room tags are untouched.
 *
 * Usage: npx tsx scripts/hero-set.ts --property=<id> --image=<imageId>
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
);
const { property, image } = args;
if (!property || !image) {
  console.error("usage: npx tsx scripts/hero-set.ts --property=<id> --image=<imageId>");
  process.exit(1);
}

const db = new Database("data/app.db");
const owned = db
  .prepare("SELECT id FROM images WHERE id=? AND property_id=?")
  .get(image, property);
if (!owned) {
  console.error(`image ${image} is not in property ${property}`);
  process.exit(1);
}

const now = new Date().toISOString();
// One hero per property: clear any previous hero flag (leave other notes alone).
db.prepare(
  "UPDATE image_tags SET notes=NULL WHERE notes='hero' AND image_id IN (SELECT id FROM images WHERE property_id=?)",
).run(property);
const has = db.prepare("SELECT image_id FROM image_tags WHERE image_id=?").get(image);
if (has) {
  db.prepare("UPDATE image_tags SET notes='hero' WHERE image_id=?").run(image);
} else {
  db.prepare(
    "INSERT INTO image_tags (image_id, notes, tagged_by, tagged_at) VALUES (?, 'hero', 'claude-code', ?)",
  ).run(image, now);
}
console.log(JSON.stringify({ property, image, hero: true }));
