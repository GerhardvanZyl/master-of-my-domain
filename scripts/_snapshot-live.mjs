// Baseline snapshot read from the LIVE app (192.168.68.125:3225), not the local
// data/app.db — the local mirror is deliberately never written (all updates go
// over POST /api/batch), so it drifts one round behind every run and diffing
// against it invents ~18 phantom "new" listings.
//
// ponytail: the home grid server-renders every property into its RSC payload,
// so scraping that is a read-only property dump with no app change. Swap to a
// real GET /api/batch?dump=1 if the home page ever stops rendering them all.
import fs from "node:fs";

const BASE = process.argv[2] || "http://192.168.68.125:3225";

const html = await fetch(BASE + "/").then((r) => {
  if (!r.ok) throw new Error(`${BASE} -> HTTP ${r.status}`);
  return r.text();
});

// RSC payload arrives as JS-string-escaped chunks in self.__next_f.push([1,"..."]).
const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) =>
  JSON.parse('"' + m[1] + '"'),
);
const flat = chunks.join("");
const i = flat.indexOf('"properties":[{');
if (i < 0) throw new Error("no properties array in the home page payload");

// Brace-match rather than regex: the array contains nested objects and quoted braces.
const start = flat.indexOf("[", i);
let depth = 0,
  end = -1,
  inStr = false,
  esc = false;
for (let k = start; k < flat.length; k++) {
  const c = flat[k];
  if (inStr) {
    if (esc) esc = false;
    else if (c === "\\") esc = true;
    else if (c === '"') inStr = false;
    continue;
  }
  if (c === '"') inStr = true;
  else if (c === "[" || c === "{") depth++;
  else if (c === "]" || c === "}") {
    depth--;
    if (depth === 0) {
      end = k;
      break;
    }
  }
}
if (end < 0) throw new Error("unterminated properties array");
const arr = JSON.parse(flat.slice(start, end + 1));

// React Flight escapes any string that STARTS with "$" by doubling it, because a
// leading "$" marks a reference in the protocol. Every price ("$790,000 - ...")
// therefore arrives as "$$790,000 - ...". Not unescaping this makes ~190 rows
// look like price changes on every run.
const unescape = (v) =>
  typeof v === "string" && v.startsWith("$$") ? v.slice(1) : v;
for (const p of arr) for (const k of Object.keys(p)) p[k] = unescape(p[k]);

const marker = new Date().toISOString();
const rows = arr.map((p) => ({
  id: p.id,
  external_id: p.externalId ?? null,
  listing_url: p.listingUrl ?? null,
  price_display: p.priceDisplay ?? null,
  price_numeric: p.priceNumeric ?? null,
  address: p.address ?? null,
  suburb: p.suburb ?? null,
  state: p.state ?? null,
  // delisted mirrors scrape_jobs.status ('sold'/'withdrawn'/'delisted'); without
  // it every already-sold row reappears as a MISSING candidate each round.
  delisted: p.delisted ?? null,
  sale_status: p.saleStatus ?? null,
  image_count: p.imageCount ?? 0,
  next_inspection: p.nextInspection ?? null,
}));
fs.mkdirSync("data/harvest", { recursive: true });
fs.writeFileSync("data/harvest/_snapshot.json", JSON.stringify({ marker, base: BASE, rows }, null, 1));
console.log(JSON.stringify({ marker, base: BASE, rows: rows.length, keys: Object.keys(arr[0]) }));
