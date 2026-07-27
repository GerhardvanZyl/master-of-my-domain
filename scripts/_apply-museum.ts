import Database from 'better-sqlite3';
import fs from 'node:fs';

const rows = fs.readFileSync('data/_museum_transit.jsonl', 'utf8')
  .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as { id: string; addr: string; min: number; routes: string });

const db = new Database('data/app.db');
const upd = db.prepare(
  "UPDATE properties SET pt_minutes_to_flinders=?, pt_route_summary=? WHERE id=?"
);
let applied = 0; const missing: string[] = [];
const tx = db.transaction(() => {
  for (const r of rows) {
    const info = upd.run(r.min, `Museum Stn 7:30am · ${r.routes}`, r.id);
    if (info.changes) applied++; else missing.push(r.id + ' (' + r.addr + ')');
  }
});
tx();
console.log(JSON.stringify({ total: rows.length, applied, missingCount: missing.length, missing }, null, 1));
db.close();
