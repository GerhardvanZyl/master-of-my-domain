import Database from "better-sqlite3";

/**
 * For properties captured from galleryV2 (photos stored in Domain's own gallery
 * order), photo ordinal 0 IS the listing's cover / og:image. Pin it as the hero
 * so the card doesn't fall back to the aspect-ratio heuristic. Skips images
 * tagged `exclude` (branding cards) and any property that already has a hero.
 * Idempotent.
 */
const db = new Database("data/app.db");

// ONLY the listings captured in this session from galleryV2, where photo
// ordinal is guaranteed to be Domain's own gallery order. Older properties were
// ingested by other paths whose ordinal is not the cover order — leave their
// existing heuristic/domain-cover heroes alone.
import fs from "node:fs";
const captured = JSON.parse(fs.readFileSync("data/harvest/_grab-images.json", "utf8")).map(
  (x) => x.listingUrl,
);
const ph = captured.map(() => "?").join(",");
const candidates = db
  .prepare(
    `SELECT p.id AS pid, p.address
       FROM properties p
      WHERE p.listing_url IN (${ph})
        AND EXISTS (SELECT 1 FROM images i WHERE i.property_id = p.id)
        AND NOT EXISTS (
          SELECT 1 FROM images i2
            JOIN image_tags t2 ON t2.image_id = i2.id
           WHERE i2.property_id = p.id AND t2.notes = 'hero')`,
  )
  .all(...captured);

const cover = db.prepare(
  `SELECT i.id FROM images i
     LEFT JOIN image_tags t ON t.image_id = i.id
    WHERE i.property_id = ?
      AND COALESCE(t.room_type, '') <> 'exclude'
    ORDER BY i.ordinal LIMIT 1`,
);
const getTag = db.prepare("SELECT image_id, notes FROM image_tags WHERE image_id = ?");
const setNotes = db.prepare("UPDATE image_tags SET notes = 'hero' WHERE image_id = ?");

let set = 0;
const skipped = [];
const tx = db.transaction(() => {
  for (const c of candidates) {
    const im = cover.get(c.pid);
    if (!im) {
      skipped.push(c.address);
      continue;
    }
    if (!getTag.get(im.id)) {
      skipped.push(c.address + " (untagged)");
      continue;
    }
    setNotes.run(im.id);
    set++;
  }
});
tx();

console.log("properties without an explicit hero:", candidates.length);
console.log("heroes set from gallery cover:", set);
console.log("skipped:", skipped.length, skipped.slice(0, 5));
