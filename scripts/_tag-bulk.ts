import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ROOM_TYPES } from "../src/db/schema";
// Apply room classifications from result-*.json files in a dir. Each file:
// [{ "imageId": "...", "room": "kitchen" }, ...]. Preserves existing notes (hero/floorplan).
const DIR = process.argv[2];
const db = new Database("data/app.db");
const valid = new Set(ROOM_TYPES as readonly string[]);
const now = new Date().toISOString();
const up = db.prepare(
  `INSERT INTO image_tags (image_id, room_type, tagged_by, tagged_at, notes)
   VALUES (@id, @room, 'claude-code', @now, NULL)
   ON CONFLICT(image_id) DO UPDATE SET
     room_type = excluded.room_type,
     tagged_by = excluded.tagged_by,
     tagged_at = excluded.tagged_at`,   // note: notes deliberately NOT touched on update
);
const imgExists = db.prepare("SELECT 1 FROM images WHERE id=?");
let applied = 0, bad = 0, missing = 0;
const files = fs.readdirSync(DIR).filter((f) => /^result-.*\.json$/.test(f));
const apply = db.transaction((rows: { imageId: string; room: string }[]) => {
  for (const r of rows) {
    if (!r || !r.imageId || !valid.has(r.room)) { bad++; continue; }
    if (!imgExists.get(r.imageId)) { missing++; continue; }
    up.run({ id: r.imageId, room: r.room, now });
    applied++;
  }
});
for (const f of files) {
  let rows: any[];
  try { rows = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { console.error("bad json", f); continue; }
  apply(rows);
}
console.log(JSON.stringify({ files: files.length, applied, badRoom: bad, missingImage: missing }));
