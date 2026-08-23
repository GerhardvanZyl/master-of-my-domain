// Throwaway: identify the exact live VIC rows missing nearestStation and/or
// ptMinutesToFlinders. Reuses _verify-live.mjs's RSC-extraction fetch approach
// (camelCase fields over HTTP) rather than the local DB or the snapshot file
// (which is snake_case and does not carry station/transit fields at all).
//
// Usage: node scripts/_find-enrichment-gaps.mjs [base]
import fs from "node:fs";

const BASE = process.argv[2] || "http://192.168.68.125:3225";

async function propsOf(path) {
  const html = await fetch(BASE + path).then((r) => {
    if (!r.ok) throw new Error(`${BASE}${path} -> HTTP ${r.status}`);
    return r.text();
  });
  const flat = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map((m) => JSON.parse('"' + m[1] + '"'))
    .join("");
  const i = flat.indexOf('"properties":[{');
  if (i < 0) return [];
  const start = flat.indexOf("[", i);
  let d = 0, end = -1, inStr = false, esc = false;
  for (let k = start; k < flat.length; k++) {
    const c = flat[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") { d--; if (d === 0) { end = k; break; } }
  }
  const arr = JSON.parse(flat.slice(start, end + 1));
  for (const p of arr) for (const k of Object.keys(p))
    if (typeof p[k] === "string" && p[k].startsWith("$$")) p[k] = p[k].slice(1);
  return arr.filter((p) => /^https?:\/\//.test(p.listingUrl || ""));
}

const vic = await propsOf("/");
const live = vic.filter((p) => !p.delisted);

const noStation = live.filter((p) => !p.nearestStation);
const noTransit = live.filter((p) => p.ptMinutesToFlinders == null);

const byUrl = new Map();
for (const p of [...noStation, ...noTransit]) byUrl.set(p.listingUrl, p);

const rows = [...byUrl.values()].map((p) => ({
  id: p.id,
  address: p.address,
  suburb: p.suburb,
  state: p.state,
  latitude: p.latitude,
  longitude: p.longitude,
  listingUrl: p.listingUrl,
  missingStation: !p.nearestStation,
  missingTransit: p.ptMinutesToFlinders == null,
}));

console.log(JSON.stringify(rows, null, 2));
console.log(`\nnoStation=${noStation.length} noTransit=${noTransit.length} union=${rows.length}`);
fs.writeFileSync("data/harvest/_enrichment-gaps.json", JSON.stringify(rows, null, 2));
