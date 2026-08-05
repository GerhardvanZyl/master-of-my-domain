// Read-only status snapshot for the sync/tag session.
import Database from "better-sqlite3";
const db = new Database("data/app.db", { readonly: true });
const one = (s) => db.prepare(s).get();
const all = (s) => db.prepare(s).all();

console.log("properties:        ", one("SELECT COUNT(*) n FROM properties").n);
console.log("images:            ", one("SELECT COUNT(*) n FROM images").n);
console.log("properties w/o imgs:", one("SELECT COUNT(*) n FROM properties WHERE id NOT IN (SELECT DISTINCT property_id FROM images)").n);
console.log("untagged images:   ", one("SELECT COUNT(*) n FROM images WHERE id NOT IN (SELECT image_id FROM image_tags)").n);
console.log("next_inspection:   ", one("SELECT COUNT(*) n FROM properties WHERE next_inspection IS NOT NULL").n);
console.log("pt_minutes null:   ", one("SELECT COUNT(*) n FROM properties WHERE pt_minutes_to_flinders IS NULL").n);
console.log("station null:      ", one("SELECT COUNT(*) n FROM properties WHERE station_distance_m IS NULL").n);

console.log("\nproperties w/o images, by suburb:");
for (const r of all(
  "SELECT COALESCE(suburb,'?') s, COUNT(*) n FROM properties WHERE id NOT IN (SELECT DISTINCT property_id FROM images) GROUP BY s ORDER BY n DESC",
))
  console.log("  ", String(r.s).padEnd(18), r.n);

console.log("\nroom tag distribution (newest 400 tags):");
for (const r of all(
  "SELECT room_type, COUNT(*) n FROM image_tags GROUP BY room_type ORDER BY n DESC",
))
  console.log("  ", String(r.room_type).padEnd(10), r.n);

console.log("\ntagged_by:");
for (const r of all("SELECT COALESCE(tagged_by,'?') t, COUNT(*) n FROM image_tags GROUP BY t ORDER BY n DESC"))
  console.log("  ", String(r.t).padEnd(12), r.n);
