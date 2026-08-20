// End-of-run verification against the LIVE app, over HTTP only.
//
// _verify.mjs opens the local data/app.db, which this job never writes — it
// would happily report a clean run while the live instance was untouched. Every
// number here is re-derived from http://192.168.68.125:3225 instead.
//
// Usage: node scripts/_verify-live.mjs [base]
import fs from "node:fs";

const BASE = process.argv[2] || "http://192.168.68.125:3225";

// Same RSC extraction as _snapshot-live.mjs — the home grid and /sydney both
// server-render their full property array into the Flight payload.
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
  // React Flight doubles a leading "$" (see _snapshot-live.mjs).
  for (const p of arr) for (const k of Object.keys(p))
    if (typeof p[k] === "string" && p[k].startsWith("$$")) p[k] = p[k].slice(1);
  return arr.filter((p) => /^https?:\/\//.test(p.listingUrl || ""));
}

const status = await fetch(`${BASE}/api/batch`).then((r) => r.json());
const vic = await propsOf("/");
const nsw = await propsOf("/sydney");

const live = vic.filter((p) => !p.delisted);
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

// Live listings that have photos but nothing usable to lead with.
const noThumb = live.filter((p) => p.imageCount > 0 && !p.thumbPath);
// Enrichment gaps on rows that should have been filled this round.
const noTransit = live.filter((p) => p.ptMinutesToFlinders == null);
const noStation = live.filter((p) => !p.nearestStation);
const noCoords = live.filter((p) => p.latitude == null);
const noPhotos = live.filter((p) => !p.imageCount);
// "Estimated" is the marker the UI turns into a "*" — it must be truthful.
const estimated = live.filter((p) => /^estimated/i.test(p.ptSteps || ""));
// A row with neither address nor price is an artifact, not a listing.
const orphans = vic.filter((p) => !p.address);

check(status.ok, "GET /api/batch did not return ok");
check(status.untagged === 0, `${status.untagged} images still untagged`);
check(noThumb.length === 0, `${noThumb.length} live listings have photos but no hero/thumb`);
check(noStation.length === 0, `${noStation.length} live VIC listings have no nearest station`);
check(noTransit.length === 0, `${noTransit.length} live VIC listings have no transit time`);
check(noCoords.length === 0, `${noCoords.length} live VIC listings have no coordinates`);
check(orphans.length === 0, `${orphans.length} VIC rows have no address (data artifacts)`);
// The 25 frozen Sydney rows must survive every round untouched.
check(nsw.length === 25, `frozen NSW rows: expected 25, found ${nsw.length}`);
check(
  nsw.every((p) => p.ptMinutesToFlinders != null),
  `${nsw.filter((p) => p.ptMinutesToFlinders == null).length} frozen NSW rows lost their transit time`,
);

const report = {
  base: BASE,
  properties: status.properties,
  images: status.totalImages,
  tagged: status.tagged,
  untagged: status.untagged,
  byRoom: status.byRoom,
  groups: status.groups?.map((g) => `${g.label}:${g.members}`),
  vicRows: vic.length,
  vicLive: live.length,
  vicDelisted: vic.length - live.length,
  nswFrozen: nsw.length,
  livePhotoless: noPhotos.length,
  liveNoThumb: noThumb.length,
  liveNoStation: noStation.length,
  liveNoTransit: noTransit.length,
  transitEstimated: estimated.length,
  orphanRows: orphans.map((p) => `${p.id} ${p.listingUrl}`),
  FAILURES: fail,
};
console.log(JSON.stringify(report, null, 1));
fs.writeFileSync("data/harvest/_verify-live.json", JSON.stringify(report, null, 1));
process.exit(fail.length ? 1 : 0);
