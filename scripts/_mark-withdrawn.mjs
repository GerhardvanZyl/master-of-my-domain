import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Mark listings withdrawn: their listing page redirects to /property-profile/
 * with no listingModel, which means the ad was pulled rather than sold.
 * Mirrors mark-sold's idempotency — clears any prior sold/withdrawn/delisted
 * scrape_jobs row for the url before inserting, so re-running replaces in place.
 * Usage: node scripts/_mark-withdrawn.mjs <externalId> [<externalId> ...]
 */
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: node scripts/_mark-withdrawn.mjs <externalId> ...");
  process.exit(1);
}
const db = new Database("data/app.db");
const now = new Date().toISOString();

for (const ext of ids) {
  const p = db
    .prepare("SELECT id, listing_url, address FROM properties WHERE external_id = ?")
    .get(ext);
  if (!p) {
    console.error("no property with external_id", ext);
    continue;
  }
  db.prepare(
    "DELETE FROM scrape_jobs WHERE url = ? AND status IN ('sold','withdrawn','delisted')",
  ).run(p.listing_url);
  db.prepare(
    "INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?, ?, 'withdrawn', ?, ?, ?)",
  ).run(randomUUID(), p.listing_url, p.id, now, now);
  console.log(JSON.stringify({ ok: true, ext, address: p.address, status: "withdrawn" }));
}
