import Database from "better-sqlite3";
import { loadProperties } from "../src/db/queries/load";
const db = new Database("data/app.db");
const rows = db.prepare("SELECT listing_url url, latitude lat, longitude lng FROM properties WHERE altitude_m IS NULL AND latitude IS NOT NULL AND state<>'NSW'").all() as any[];
console.log("need altitude:", rows.length);
if (rows.length) {
  const r = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" + rows.map((r) => r.lat).join(",") + "&longitude=" + rows.map((r) => r.lng).join(","));
  const j = (await r.json()) as any;
  const out = rows.map((r, i) => ({ listingUrl: r.url, altitudeM: Math.round(j.elevation[i] * 10) / 10 })).filter((o) => !isNaN(o.altitudeM));
  console.log(JSON.stringify(loadProperties(out)));
}
