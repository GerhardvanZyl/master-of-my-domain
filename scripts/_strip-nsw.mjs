// Remove the frozen NSW/Sydney rows from a harvest file before `npm run load`.
//
// compute-stations.ts and compute-metadata.ts read the whole DB, so their output
// includes the 25 Sydney listings that are NOT part of this search and are frozen
// by user rule (their Museum-Station transit was computed by hand and must never
// be recomputed). Loading their rows would overwrite that work with Melbourne
// assumptions.
//
// Usage: node scripts/_strip-nsw.mjs data/harvest/stations.json
import fs from "node:fs";
import Database from "better-sqlite3";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/_strip-nsw.mjs <harvest.json>");
  process.exit(1);
}
const db = new Database("data/app.db", { readonly: true });
const nsw = new Set(
  db.prepare("SELECT listing_url u FROM properties WHERE state = 'NSW'").all().map((r) => r.u),
);

const items = JSON.parse(fs.readFileSync(file, "utf8"));
const kept = items.filter((i) => !nsw.has(i.listingUrl));
fs.writeFileSync(file, JSON.stringify(kept, null, 1));
console.log(JSON.stringify({ file, before: items.length, removedNsw: items.length - kept.length, after: kept.length }));
