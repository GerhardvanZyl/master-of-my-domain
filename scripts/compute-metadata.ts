/**
 * compute-metadata.ts — standalone metadata computer.
 *
 * For each harvested property computes:
 *   - greenCrossDistanceM: straight-line metres to the nearest Greencross-
 *     branded vet (falls back to nearest veterinary clinic of any brand if
 *     no Greencross-tagged vet exists anywhere in the Overpass results).
 *   - playgrounds500m:     count of public playgrounds within 500 m.
 *   - colesDistanceM / colesName: nearest Coles supermarket + its name.
 *
 * Suburb-agnostic: property coordinates are clustered (greedy single-link,
 * ~30 km) and each cluster's bbox is queried against the live Overpass API
 * per POI type; results are merged across clusters before ranking. See
 * scripts/lib/overpass-poi.ts for the clustering/caching mechanics. No
 * coordinate here is hand-entered — everything comes from Overpass (live or
 * cached from a prior live run).
 *
 * Run: npx tsx scripts/compute-metadata.ts
 * Writes: data/harvest/metadata.json (write-only — does not load into the DB)
 */
import "../src/lib/load-env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sqlite } from "../src/db/client";
import { getPois, haversineM, type Point } from "./lib/overpass-poi";

type Row = {
  listingUrl: string;
  latitude: number | null;
  longitude: number | null;
  suburb: string | null;
};

function summarize(label: string, values: (number | null)[], suburbs: (string | null)[]) {
  const bySuburb = new Map<string, number[]>();
  values.forEach((v, i) => {
    if (v == null) return;
    const key = suburbs[i] ?? "(unknown)";
    if (!bySuburb.has(key)) bySuburb.set(key, []);
    bySuburb.get(key)!.push(v);
  });
  console.log(`\n${label} by suburb:`);
  for (const [suburb, ds] of Array.from(bySuburb.entries()).sort((a, b) => b[1].length - a[1].length)) {
    ds.sort((a, b) => a - b);
    const min = ds[0];
    const max = ds[ds.length - 1];
    const median = ds[Math.floor(ds.length / 2)];
    console.log(`  ${suburb.padEnd(20)} n=${String(ds.length).padStart(3)}  min=${min}  median=${median}  max=${max}`);
  }
}

async function main() {
  const props = sqlite
    .prepare(
      "SELECT listing_url AS listingUrl, latitude, longitude, suburb FROM properties WHERE latitude IS NOT NULL",
    )
    .all() as Row[];
  console.log(`Loaded ${props.length} properties with coordinates.`);

  const points: Point[] = props.map((p) => ({ lat: p.latitude!, lng: p.longitude! }));

  const playgrounds = await getPois("playground", points, { paddingKm: 10 });
  console.log(`Overpass returned ${playgrounds.length} distinct leisure=playground elements.`);

  const coles = await getPois("coles", points, { paddingKm: 10 });
  console.log(`Overpass returned ${coles.length} distinct Coles supermarket elements.`);

  const vets = await getPois("vet", points, { paddingKm: 10 });
  console.log(`Overpass returned ${vets.length} distinct amenity=veterinary elements.`);

  const greencross = vets.filter((v) => /greencross/i.test(v.tags.name ?? ""));
  const usingFallbackVet = greencross.length === 0 && vets.length > 0;
  if (greencross.length === 0) {
    console.log(
      vets.length > 0
        ? "No Greencross-branded vet found in any cluster's Overpass results — falling back to nearest veterinary clinic of any brand for greenCrossDistanceM."
        : "No veterinary clinics of any brand were returned by Overpass.",
    );
  }
  const vetCandidates = usingFallbackVet ? vets : greencross;

  if (coles.length === 0) {
    console.error(
      "No Coles supermarkets returned by Overpass across any cluster — refusing to write metadata.json.",
    );
    process.exit(1);
  }
  if (vetCandidates.length === 0) {
    console.error(
      "No veterinary clinics (Greencross or otherwise) returned by Overpass — refusing to write metadata.json.",
    );
    process.exit(1);
  }
  if (playgrounds.length === 0) {
    console.warn("Warning: 0 playgrounds returned by Overpass across all clusters.");
  }

  const out = props.map((p) => {
    const { listingUrl, latitude: lat, longitude: lng } = p;
    if (lat == null || lng == null) {
      return {
        listingUrl,
        greenCrossDistanceM: null,
        playgrounds500m: null,
        colesDistanceM: null,
        colesName: null,
      };
    }

    let vetD = Infinity;
    for (const v of vetCandidates) {
      const d = haversineM(lat, lng, v.lat, v.lng);
      if (d < vetD) vetD = d;
    }

    const playgrounds500m = playgrounds.reduce(
      (n, pg) => n + (haversineM(lat, lng, pg.lat, pg.lng) <= 500 ? 1 : 0),
      0,
    );

    let nearestColes = coles[0];
    let colesD = Infinity;
    for (const c of coles) {
      const d = haversineM(lat, lng, c.lat, c.lng);
      if (d < colesD) {
        colesD = d;
        nearestColes = c;
      }
    }

    return {
      listingUrl,
      greenCrossDistanceM: Math.round(vetD),
      playgrounds500m,
      colesDistanceM: Math.round(colesD),
      colesName: nearestColes.tags.name ?? "Coles",
    };
  });

  const outPath = resolve(process.cwd(), "data/harvest/metadata.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} rows -> ${outPath}`);
  console.log(`With coords: ${out.filter((r) => r.greenCrossDistanceM != null).length}`);

  const suburbs = props.map((p) => p.suburb);
  summarize(
    "Coles distance (m)",
    out.map((r) => r.colesDistanceM),
    suburbs,
  );
  summarize(
    "Greencross/vet distance (m)",
    out.map((r) => r.greenCrossDistanceM),
    suburbs,
  );
  summarize(
    "Playgrounds within 500m (count)",
    out.map((r) => r.playgrounds500m),
    suburbs,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
