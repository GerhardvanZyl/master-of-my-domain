import Database from 'better-sqlite3';
const db = new Database('data/app.db');
const now = new Date().toISOString();

// Properties that already have an explicit hero — leave untouched.
const heroProp = new Set<string>(
  (db.prepare("SELECT DISTINCT i.property_id pid FROM image_tags t JOIN images i ON i.id=t.image_id WHERE t.notes='hero'").all() as any[]).map(r => r.pid)
);

// First "real photo" for a property: lowest ordinal image whose room is an actual room
// (not 'other') and which isn't flagged as a floorplan.
const firstReal = db.prepare(
  `SELECT i.id FROM images i JOIN image_tags t ON t.image_id=i.id
   WHERE i.property_id=? AND t.room_type IS NOT NULL AND t.room_type<>'other'
     AND (t.notes IS NULL OR t.notes<>'floorplan')
   ORDER BY i.ordinal ASC, i.id ASC LIMIT 1`
);
const setHero = db.prepare("UPDATE image_tags SET notes='hero', tagged_by='first-photo-heuristic', tagged_at=? WHERE image_id=?");

const props = db.prepare("SELECT id FROM properties").all() as any[];
let set = 0, skippedNoReal = 0, alreadyHero = 0;
const tx = db.transaction(() => {
  for (const p of props) {
    if (heroProp.has(p.id)) { alreadyHero++; continue; }
    const hit = firstReal.get(p.id) as any;
    if (!hit) { skippedNoReal++; continue; }
    setHero.run(now, hit.id);
    set++;
  }
});
tx();
console.log(JSON.stringify({ totalProps: props.length, alreadyHero, set, skippedNoReal }, null, 1));
db.close();
