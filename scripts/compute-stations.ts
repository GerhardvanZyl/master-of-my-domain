/**
 * compute-stations.ts — nearest + second-nearest train station (straight-line)
 * for every property with coordinates.
 *
 * Suburb-agnostic: property coordinates are clustered (greedy single-link,
 * ~30 km), each cluster's bbox is queried against the live Overpass API for
 * railway=station, and results are merged before ranking. See
 * scripts/lib/overpass-poi.ts for the clustering/caching mechanics.
 *
 * Run: npx tsx scripts/compute-stations.ts
 * Writes: data/harvest/stations.json (write-only — does not load into the DB)
 */
import "../src/lib/load-env";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../src/db/client";
import { getPois, haversineM, type Point } from "./lib/overpass-poi";

type Row = { u: string; lat: number; lng: number; suburb: string | null };

function stationName(tags: Record<string, string>): string | null {
  const name = tags.name?.trim();
  if (!name) return null;
  return /station$/i.test(name) ? name : `${name} Station`;
}

async function main() {
  const rows = sqlite
    .prepare(
      "SELECT listing_url u, latitude lat, longitude lng, suburb FROM properties WHERE latitude IS NOT NULL",
    )
    .all() as Row[];
  console.log(`Loaded ${rows.length} properties with coordinates.`);

  const points: Point[] = rows.map((r) => ({ lat: r.lat, lng: r.lng }));
  // >=30km padding per cluster bbox, per brief: Point Cook and Torquay both
  // have no station in-suburb, so the nearest one is always outside the
  // property cluster itself.
  const stations = await getPois("station", points, { paddingKm: 30 });
  console.log(
    `Overpass returned ${stations.length} distinct railway=station elements (merged across clusters).`,
  );

  const named = stations
    .map((s) => ({ name: stationName(s.tags), lat: s.lat, lng: s.lng }))
    .filter((s): s is { name: string; lat: number; lng: number } => s.name != null);

  if (named.length === 0) {
    console.error(
      "No named railway stations returned by Overpass across any cluster — refusing to write stations.json.",
    );
    process.exit(1);
  }

  const out = rows.map((r) => {
    // Collapse multiple OSM elements representing the same physical station
    // (e.g. platform nodes + a way outline) down to one entry per name before
    // ranking, so "second station" isn't just a duplicate of the nearest one.
    const byName = new Map<string, number>();
    for (const s of named) {
      const d = haversineM(r.lat, r.lng, s.lat, s.lng);
      const prev = byName.get(s.name);
      if (prev == null || d < prev) byName.set(s.name, d);
    }
    const ranked = Array.from(byName.entries())
      .map(([name, d]) => ({ name, d: Math.round(d) }))
      .sort((a, b) => a.d - b.d);
    return {
      listingUrl: r.u,
      nearestStation: ranked[0]?.name ?? null,
      stationDistanceM: ranked[0]?.d ?? null,
      secondStation: ranked[1]?.name ?? null,
      secondStationDistanceM: ranked[1]?.d ?? null,
    };
  });

  const dest = path.resolve(process.cwd(), "data/harvest/stations.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} rows to ${dest}`);

  // Per-suburb summary so the result is verifiable at a glance.
  const bySuburb = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const d = out[i].stationDistanceM;
    if (d == null) return;
    const key = r.suburb ?? "(unknown)";
    if (!bySuburb.has(key)) bySuburb.set(key, []);
    bySuburb.get(key)!.push(d);
  });
  console.log("\nNearest-station distance by suburb:");
  for (const [suburb, ds] of Array.from(bySuburb.entries()).sort((a, b) => b[1].length - a[1].length)) {
    ds.sort((a, b) => a - b);
    const min = ds[0];
    const max = ds[ds.length - 1];
    const median = ds[Math.floor(ds.length / 2)];
    console.log(
      `  ${suburb.padEnd(20)} n=${String(ds.length).padStart(3)}  min=${min}m  median=${median}m  max=${max}m`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
