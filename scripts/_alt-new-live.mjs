// Altitude for the listings added this round, as a /api/batch payload.
//
// _alt-new.ts calls loadProperties() straight into the local data/app.db, which
// this job never writes; and it selects "altitude_m IS NULL" from that same
// stale DB, so it would miss every listing that only exists on the live app.
// Input is the round's new-listing file instead.
//
// Usage: node scripts/_alt-new-live.mjs [data/harvest/_new.json]
import fs from "node:fs";

const src = process.argv[2] || "data/harvest/_new.json";
const rows = JSON.parse(fs.readFileSync(src, "utf8")).filter(
  (p) => p.latitude != null && p.longitude != null && p.state !== "NSW",
);
console.log("need altitude:", rows.length);
if (!rows.length) process.exit(0);

const url =
  "https://api.open-meteo.com/v1/elevation?latitude=" +
  rows.map((r) => r.latitude).join(",") +
  "&longitude=" +
  rows.map((r) => r.longitude).join(",");
const j = await fetch(url).then((r) => r.json());
if (!Array.isArray(j?.elevation) || j.elevation.length !== rows.length) {
  throw new Error(`open-meteo returned ${j?.elevation?.length ?? "no"} elevations for ${rows.length} points`);
}

const properties = rows
  .map((r, i) => ({ listingUrl: r.listingUrl, altitudeM: Math.round(j.elevation[i] * 10) / 10 }))
  .filter((o) => Number.isFinite(o.altitudeM));
fs.writeFileSync("data/harvest/_batch-alt.json", JSON.stringify({ properties }, null, 1));
console.log(JSON.stringify({ wrote: properties.length, file: "data/harvest/_batch-alt.json" }));
