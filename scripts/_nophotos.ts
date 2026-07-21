import { sqlite } from "../src/db/client";

// Listings Domain has withdrawn — they 301 to /property-profile/ and have no
// gallery, so they'd resurface at the top of the queue forever.
const EXPIRED = ["26-kittyhawk-road-point-cook-vic-3030-2020476815"];

const rows = sqlite
  .prepare(
    `SELECT id, listing_url AS url FROM properties p
     WHERE NOT EXISTS (SELECT 1 FROM images i WHERE i.property_id = p.id)
     ORDER BY p.created_at DESC`,
  )
  .all() as { id: string; url: string }[];
const live = rows.filter((r) => !EXPIRED.some((e) => r.url.includes(e)));
const n = Number(process.argv[2] || 8);
console.log("remaining", live.length, `(+${rows.length - live.length} expired)`);
for (const r of live.slice(0, n)) console.log(r.url);
