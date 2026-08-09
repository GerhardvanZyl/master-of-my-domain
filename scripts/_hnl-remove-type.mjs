// Remove VIC house-and-land / off-the-plan rows identified by Domain's own
// property_type ("New House & Land", "New Apartments / Off the Plan").
// User rule: completed homes only. Guards anything carrying ratings or images.
// NSW rows are frozen and never touched. Dry run unless --apply.
import Database from "better-sqlite3";

const APPLY = process.argv.includes("--apply");
const db = new Database("data/app.db");

const rows = db
  .prepare(
    `SELECT id, address, suburb, price_display FROM properties
     WHERE state = 'VIC' AND (property_type LIKE 'New %' OR property_type LIKE '%Off the Plan%')`,
  )
  .all();

const del = db.transaction((list) => {
  for (const r of list) {
    // scrape_jobs is the one FK with onDelete NO ACTION — clear it first.
    db.prepare("DELETE FROM scrape_jobs WHERE property_id = ?").run(r.id);
    db.prepare("DELETE FROM price_history WHERE property_id = ?").run(r.id);
    db.prepare("DELETE FROM properties WHERE id = ?").run(r.id);
  }
});

const doomed = [];
for (const r of rows) {
  const g = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM property_ratings WHERE property_id = ?) AS r, (SELECT COUNT(*) FROM images WHERE property_id = ?) AS i",
    )
    .get(r.id, r.id);
  if (g.r || g.i) console.log("SKIP (has ratings/images):", r.address);
  else doomed.push(r);
}

for (const r of doomed) console.log((APPLY ? "deleting: " : "would delete: ") + r.address + " | " + r.price_display);
if (APPLY) del(doomed);
console.log(`\n${doomed.length} rows${APPLY ? " deleted" : " (dry run — pass --apply)"}`);
