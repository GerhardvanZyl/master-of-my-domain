/**
 * Fill altitude_m for every property with coords, via the free open-meteo
 * elevation API (no key, batches of 100). Writes data/harvest/altitude.json
 * ([{listingUrl, altitudeM}]) then loads it. Idempotent.
 *   npx tsx scripts/compute-altitude.ts
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadProperties } from "../src/db/queries/load";

const db = new Database(path.resolve("data/app.db"));
const rows = db
  .prepare(
    "SELECT listing_url AS url, latitude AS lat, longitude AS lng FROM properties WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
  )
  .all() as { url: string; lat: number; lng: number }[];

const out: { listingUrl: string; altitudeM: number }[] = [];
const chunk = 100;
for (let i = 0; i < rows.length; i += chunk) {
  const batch = rows.slice(i, i + chunk);
  const lats = batch.map((r) => r.lat).join(",");
  const lngs = batch.map((r) => r.lng).join(",");
  const res = await fetch(
    `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`,
  );
  if (!res.ok) throw new Error(`elevation API ${res.status}`);
  const json = (await res.json()) as { elevation: number[] };
  batch.forEach((r, j) => {
    const e = json.elevation[j];
    if (typeof e === "number") out.push({ listingUrl: r.url, altitudeM: Math.round(e * 10) / 10 });
  });
  console.log(`  ${out.length}/${rows.length}`);
}

fs.mkdirSync("data/harvest", { recursive: true });
fs.writeFileSync("data/harvest/altitude.json", JSON.stringify(out, null, 1));
const r = loadProperties(out);
console.log("loaded altitude:", r);
