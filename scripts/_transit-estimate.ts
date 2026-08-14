/**
 * Fill pt_minutes_to_flinders for properties that have none, by copying the
 * geographically-nearest already-measured property in the SAME suburb group.
 * In Point Cook the nearest neighbour is typically 100-200 m away (same bus
 * stop + Werribee-line train); in Torquay it's the same drive-to-Waurn-Ponds
 * chain. Values are prefixed "Estimated" so the UI flags them with `*`.
 * Frozen NSW rows are excluded. Idempotent.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { loadProperties } from "../src/db/queries/load";

// Read-only: the measured neighbours come from here, but nothing is written
// back — writes go to the live app over HTTP (see OUT_JSON below).
const db = new Database("data/app.db", { readonly: true });
type Row = {
  url: string;
  address: string;
  suburb: string;
  lat: number;
  lng: number;
  mins: number | null;
  route: string | null;
  steps: string | null;
};

const all = db
  .prepare(
    `SELECT listing_url url, address, suburb, latitude lat, longitude lng,
            pt_minutes_to_flinders mins, pt_route_summary route, pt_steps steps
     FROM properties WHERE state <> 'NSW' AND latitude IS NOT NULL`,
  )
  .all() as Row[];

// Torquay's commute model is different (drive + V/Line), so never cross the line.
const zone = (r: Row) => (r.suburb === "Torquay" ? "surfcoast" : "metro");
const known = all.filter((r) => r.mins != null);
// NEED_JSON supplies the properties to estimate from a harvest file, for
// listings that exist only on the live app and were never loaded locally.
// The measured pool still comes from the DB.
const needSrc = process.env.NEED_JSON;
const need: Row[] = needSrc
  ? (
      JSON.parse(fs.readFileSync(needSrc, "utf8")) as {
        listingUrl: string;
        address?: string;
        suburb?: string;
        latitude?: number;
        longitude?: number;
        state?: string;
      }[]
    )
      .filter((p) => p.latitude != null && p.state !== "NSW")
      .map((p) => ({
        url: p.listingUrl,
        address: p.address ?? p.listingUrl,
        suburb: p.suburb ?? "",
        lat: p.latitude!,
        lng: p.longitude!,
        mins: null,
        route: null,
        steps: null,
      }))
  : all.filter((r) => r.mins == null);

const dist = (a: Row, b: Row) => {
  const R = 6371000,
    t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t,
    dLng = (b.lng - a.lng) * t;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};

const out = [];
for (const r of need) {
  const pool = known.filter((k) => zone(k) === zone(r));
  if (!pool.length) {
    console.warn("no measured neighbour for", r.address);
    continue;
  }
  let best = pool[0],
    bd = dist(r, best);
  for (const k of pool) {
    const d = dist(r, k);
    if (d < bd) (best = k), (bd = d);
  }
  out.push({
    listingUrl: r.url,
    ptMinutesToFlinders: best.mins,
    ptRouteSummary: best.route ?? undefined,
    ptSteps: `Estimated from nearest tracked property (${best.address}, ~${bd} m away): ${best.steps ?? best.route}`,
  });
  console.log(`${r.address}  <-  ${best.address} (${bd} m, ${best.mins} min)`);
}

if (process.env.OUT_JSON) {
  fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 1));
  console.log(`\nWrote ${out.length} rows -> ${process.env.OUT_JSON}`);
} else if (process.argv.includes("--apply")) {
  console.log(JSON.stringify(loadProperties(out)));
} else {
  console.log(`\n${out.length} would be set. Re-run with --apply to write.`);
}
