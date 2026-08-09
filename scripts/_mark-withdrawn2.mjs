// Mark listings withdrawn: gone from the search feed AND their own listing page
// redirects to /property-profile/ (or /sale/) with no listingModel — i.e. pulled,
// not sold. Idempotent: replaces any prior sold/withdrawn/delisted job row.
// Usage: node scripts/_mark-withdrawn2.mjs <externalId> [...]
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const db = new Database("data/app.db");
const now = new Date().toISOString();

for (const ext of process.argv.slice(2)) {
  const p = db.prepare("SELECT id, listing_url u, address FROM properties WHERE external_id = ?").get(ext);
  if (!p) {
    console.log("NOT FOUND", ext);
    continue;
  }
  db.prepare("DELETE FROM scrape_jobs WHERE url = ? AND status IN ('delisted','sold','withdrawn')").run(p.u);
  db.prepare(
    "INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(randomUUID(), p.u, "withdrawn", p.id, now, now);
  console.log("withdrawn:", p.address);
}
