import "../src/lib/load-env";
import { readFileSync } from "node:fs";
import { sqlite } from "../src/db/client";
import { loadProperties, type LoadItem } from "../src/db/queries/load";

const scratch =
  "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/a49b4448-62e1-490e-8342-ffd6055e5d86/scratchpad";
const marker = readFileSync(scratch + "/marker.txt", "utf8").trim();

// The newly-inserted Point Cook / Williams Landing listings.
const newRows = sqlite
  .prepare(
    `SELECT id, listing_url u, latitude lat, longitude lng
       FROM properties
      WHERE created_at >= ? AND latitude IS NOT NULL
        AND (listing_url LIKE '%point-cook-vic-3030%' OR listing_url LIKE '%williams-landing-vic-3027%')`,
  )
  .all(marker) as { id: string; u: string; lat: number; lng: number }[];
const newUrls = new Set(newRows.map((r) => r.u));

const stations = JSON.parse(
  readFileSync("data/harvest/stations.json", "utf8"),
) as any[];
const metadata = JSON.parse(
  readFileSync("data/harvest/metadata.json", "utf8"),
) as any[];
const byUrl = new Map<string, LoadItem>();
const take = (arr: any[]) => {
  for (const r of arr) {
    if (!newUrls.has(r.listingUrl)) continue;
    const cur = byUrl.get(r.listingUrl) ?? { listingUrl: r.listingUrl };
    byUrl.set(r.listingUrl, { ...cur, ...r });
  }
};
take(stations);
take(metadata);

// Transit estimate: nearest already-measured PC/WL neighbour (haversine).
const haversine = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const tracked = sqlite
  .prepare(
    `SELECT address a, latitude lat, longitude lng,
            pt_minutes_to_flinders m, pt_route_summary rs, pt_steps st
       FROM properties
      WHERE pt_minutes_to_flinders IS NOT NULL AND latitude IS NOT NULL
        AND (listing_url LIKE '%point-cook-vic-3030%' OR listing_url LIKE '%williams-landing-vic-3027%')`,
  )
  .all() as { a: string; lat: number; lng: number; m: number; rs: string; st: string }[];

for (const r of newRows) {
  let best: (typeof tracked)[0] | null = null;
  let bestD = Infinity;
  for (const t of tracked) {
    const d = haversine(r.lat, r.lng, t.lat, t.lng);
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best) continue;
  const cur = byUrl.get(r.u) ?? { listingUrl: r.u };
  cur.ptMinutesToFlinders = best.m;
  cur.ptRouteSummary = best.rs;
  cur.ptSteps = `Estimated from nearest tracked property (${best.a}, ~${Math.round(bestD)} m away): ${best.st ?? best.rs}`;
  byUrl.set(r.u, cur);
}

const items = [...byUrl.values()];
const result = loadProperties(items);
console.log(
  JSON.stringify(
    {
      newProps: newRows.length,
      loaded: items.length,
      result,
      sample: items[0],
    },
    null,
    1,
  ),
);
