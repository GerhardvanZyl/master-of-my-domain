import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * Remove house-and-land / off-the-plan package listings — the user wants
 * completed homes only. Evidence, strongest first:
 *   1. Domain's own listingSummary.status === 'newDevelopment'
 *   2. package address shapes: "Lot N", "TURNKEY ...", "CORNER ...",
 *      "<Estate> Grove - <Street>"
 *   3. Torquay listings in the Briody Grove / Eucalypt Way estates, which are
 *      the same packages re-listed under a tidied street address (they share an
 *      address with a confirmed newDevelopment listing).
 * Pass --apply to delete; default is a dry run.
 */
const APPLY = process.argv.includes("--apply");
const db = new Database("data/app.db");

const status = new Map();
try {
  for (const s of JSON.parse(fs.readFileSync("data/harvest/_grab-status.json", "utf8")))
    status.set(String(s.ext), s.status);
} catch {}

const rows = db
  .prepare("SELECT id, external_id, address, suburb, price_display, listing_url FROM properties")
  .all();

const hits = [];
for (const r of rows) {
  const a = r.address ?? "";
  const st = status.get(String(r.external_id));
  let why = null;
  if (st === "newDevelopment") why = "status=newDevelopment";
  else if (/\bturnkey\b/i.test(a)) why = "address: TURNKEY";
  else if (/^lot\s/i.test(a)) why = "address: Lot N";
  else if (/^corner\s/i.test(a)) why = "address: CORNER";
  else if (/\s-\s/.test(a) && /\b(grove|estate)\b/i.test(a)) why = "address: estate - street";
  // "calypt" catches Domain's own typo variants (Eucalypt / Ecalypt / Eucalypt Way).
  else if (r.suburb === "Torquay" && /\bbriody\b|calypt/i.test(a))
    why = "Briody/Eucalypt estate package";
  if (why) hits.push({ ...r, st, why });
}

console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (pass --apply to delete) ===");
console.log("matches:", hits.length);
const bySub = {};
for (const h of hits) bySub[h.suburb] = (bySub[h.suburb] || 0) + 1;
console.log("by suburb:", JSON.stringify(bySub));
for (const h of hits)
  console.log(
    "  ", String(h.external_id).padEnd(11), String(h.suburb).slice(0, 11).padEnd(11),
    String(h.address).slice(0, 42).padEnd(42), "|", h.why,
  );

// Safety: never drop something the user has invested in.
const guarded = hits.filter((h) => {
  const rated = db.prepare("SELECT COUNT(*) n FROM property_ratings WHERE property_id = ?").get(h.id).n;
  const noted = db.prepare("SELECT domain_notes FROM properties WHERE id = ?").get(h.id).domain_notes;
  return rated > 0 || (noted && noted.trim());
});
if (guarded.length) {
  console.log("\nSKIPPING (has your ratings/notes):");
  for (const g of guarded) console.log("  ", g.external_id, g.address);
}
const doomed = hits.filter((h) => !guarded.includes(h));

if (APPLY) {
  const del = db.transaction(() => {
    for (const h of doomed) {
      db.prepare("DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE property_id = ?)").run(h.id);
      db.prepare("DELETE FROM similarity_group_members WHERE image_id IN (SELECT id FROM images WHERE property_id = ?)").run(h.id);
      db.prepare("DELETE FROM images WHERE property_id = ?").run(h.id);
      db.prepare("DELETE FROM price_history WHERE property_id = ?").run(h.id);
      db.prepare("DELETE FROM property_ratings WHERE property_id = ?").run(h.id);
      db.prepare("DELETE FROM shares WHERE property_id = ?").run(h.id);
      // scrape_jobs is the only FK to properties with onDelete=NO ACTION.
      db.prepare("DELETE FROM scrape_jobs WHERE property_id = ?").run(h.id);
      db.prepare("DELETE FROM properties WHERE id = ?").run(h.id);
    }
  });
  del();
  console.log("\ndeleted:", doomed.length);
  console.log("properties remaining:", db.prepare("SELECT COUNT(*) n FROM properties").get().n);
} else {
  console.log("\nwould delete:", doomed.length);
}
