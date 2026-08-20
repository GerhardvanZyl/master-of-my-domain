// Build the six room comparison groups' top-up straight from the tag payloads
// this round produced.
//
// _group-topup.ts does the same job by querying the local data/app.db, which is
// never written here — the photos and tags live only on the live app. But every
// property that needs adding is a property we just tagged, and _tag-remote.ts
// records propertyId + ordinal alongside each tag, so the representative image
// is pickable without touching a database or re-scraping the live pages.
//
// Rule (unchanged): ONE image per property per group — the app renders one
// column per property — and it is that property's lowest-ordinal photo of the
// room type. Idempotent: /api/batch reuses a group by label and dedupes members.
//
// Usage: node scripts/_groups-from-tags.mjs out.json data/harvest/_tags-1.json [...]
import fs from "node:fs";

const ROOMS = ["kitchen", "bathroom", "bedroom", "living", "dining", "exterior"];

const out = process.argv[2];
const files = process.argv.slice(3);
if (!out || !files.length) {
  console.error("usage: node scripts/_groups-from-tags.mjs <out.json> <tags.json...>");
  process.exit(1);
}

// propertyId -> room -> {ordinal, imageId}
const best = new Map();
let seen = 0;
for (const f of files) {
  for (const t of JSON.parse(fs.readFileSync(f, "utf8")).tags ?? []) {
    seen++;
    if (!t.propertyId || !ROOMS.includes(t.roomType)) continue;
    const byRoom = best.get(t.propertyId) ?? new Map();
    const cur = byRoom.get(t.roomType);
    if (!cur || t.ordinal < cur.ordinal) byRoom.set(t.roomType, { ordinal: t.ordinal, imageId: t.imageId });
    best.set(t.propertyId, byRoom);
  }
}

const groups = ROOMS.map((room) => ({
  label: room,
  roomType: room,
  imageIds: [...best.values()].map((byRoom) => byRoom.get(room)?.imageId).filter(Boolean),
})).filter((g) => g.imageIds.length);

fs.writeFileSync(out, JSON.stringify({ groups }, null, 1));
console.log(
  JSON.stringify({
    tagsRead: seen,
    properties: best.size,
    groups: groups.map((g) => ({ label: g.label, members: g.imageIds.length })),
    out,
  }),
);
