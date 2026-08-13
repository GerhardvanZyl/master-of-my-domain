// Pre-sync snapshot: prices + a UTC marker. The diff afterwards is
//   NEW      = created_at >= marker
//   CHANGED  = price_numeric differs from this snapshot
//   MISSING  = domain row updated_at < marker, not already delisted, and its url
//              matches the searched suburbs — that suburb filter is ESSENTIAL or
//              the 25 frozen NSW rows get swept in as "missing" every run.
import fs from "node:fs";
import Database from "better-sqlite3";

const db = new Database("data/app.db", { readonly: true });
const marker = new Date().toISOString();
const rows = db
  .prepare(
    "SELECT id, external_id, listing_url, price_display, price_numeric, address FROM properties",
  )
  .all();
fs.mkdirSync("data/harvest", { recursive: true });
fs.writeFileSync("data/harvest/_snapshot.json", JSON.stringify({ marker, rows }, null, 1));
console.log(JSON.stringify({ marker, rows: rows.length }));
