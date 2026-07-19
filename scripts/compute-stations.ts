import "../src/lib/load-env";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../src/db/client";

// Nearest + next-closest train station (straight-line) for each property.
// Werribee line + nearby west-Melbourne stations. Point Cook itself has none.
const STATIONS: { name: string; lat: number; lng: number }[] = [
  { name: "Williams Landing Station", lat: -37.86723, lng: 144.74619 },
  { name: "Aircraft Station", lat: -37.8736, lng: 144.75726 },
  { name: "Laverton Station", lat: -37.8637, lng: 144.7686 },
  { name: "Hoppers Crossing Station", lat: -37.88232, lng: 144.69968 },
  { name: "Werribee Station", lat: -37.8993, lng: 144.6614 },
  { name: "Tarneit Station", lat: -37.83303, lng: 144.696 },
  { name: "Wyndham Vale Station", lat: -37.889, lng: 144.622 },
];

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const rows = sqlite
  .prepare(
    "SELECT listing_url u, latitude lat, longitude lng FROM properties WHERE latitude IS NOT NULL",
  )
  .all() as { u: string; lat: number; lng: number }[];

const out = rows.map((r) => {
  const ranked = STATIONS.map((s) => ({
    name: s.name,
    d: Math.round(haversine(r.lat, r.lng, s.lat, s.lng)),
  })).sort((a, b) => a.d - b.d);
  return {
    listingUrl: r.u,
    nearestStation: ranked[0].name,
    stationDistanceM: ranked[0].d,
    secondStation: ranked[1].name,
    secondStationDistanceM: ranked[1].d,
  };
});

const dest = path.resolve(process.cwd(), "data/harvest/stations.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} rows to ${dest}`);
console.log(JSON.stringify(out.slice(0, 3), null, 2));
