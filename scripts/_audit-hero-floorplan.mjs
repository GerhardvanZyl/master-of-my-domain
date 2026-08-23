// Throwaway, read-only coverage audit for hero images and floorplans, driven
// entirely over HTTP against the LIVE app. Never opens data/app.db — see
// scripts/_verify-live.mjs's own header for why that file is off-limits for
// this kind of check.
//
// hasExplicitHero is NOT measurable from the rendered page: notes='hero' only
// steers which image pickHero() (src/db/queries/properties.ts) returns, and
// the rendered PhotoGrid badge shows roomType (kitchen/bathroom/...), never
// notes. An explicit hero and a heuristic-picked hero render identically, so
// this script reports hasExplicitHero: null throughout rather than guessing
// from a proxy signal (e.g. "hero is the first image" would be wrong for any
// listing where the heuristic and an explicit tag happen to agree, and there
// is no way to tell those apart after the fact).
//
// Usage: node scripts/_audit-hero-floorplan.mjs [base]
import fs from "node:fs";

const BASE = process.argv[2] || "http://192.168.68.125:3225";

// Same RSC extraction as _verify-live.mjs / _snapshot-live.mjs.
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

// Same room set + badge regex as scripts/_tag-remote.ts, so "untagged" here
// means exactly what that script means by it.
const ROOMS = new Set([
  "kitchen", "bathroom", "bedroom", "living", "dining",
  "exterior", "other", "aerial", "exclude",
]);

/**
 * Distinct img_<hex> ids in document order, with whether any rendering of
 * that image on the page carries a room badge.
 *
 * _tag-remote.ts's own regex — `(img_[0-9a-f]+)\.webp([\s\S]{0,400})`, taking
 * only the FIRST occurrence of each id — does not carry over to this
 * question ("is this image tagged anywhere on the page?") and had to be
 * fixed in three ways, each confirmed empirically against live pages before
 * settling on this version:
 *
 *  1. Every image id appears many times per property page (HeroGallery +
 *     showcase strip + PhotoGrid + Lightbox, each its own next/image with a
 *     multi-width srcset) and only the PhotoGrid rendering sits next to a
 *     badge. HeroGallery renders before PhotoGrid in document order, so
 *     "first occurrence" is systematically the wrong one for any hero or
 *     showcase photo — confirmed on a live page where the true first
 *     occurrence had no badge nearby but a later PhotoGrid occurrence of the
 *     same id did.
 *  2. A fixed lookahead window (400 chars, or any other fixed size tried up
 *     to 2000) is unsound with matchAll's non-overlapping semantics: the
 *     window itself is consumed as part of the match, so a large window can
 *     jump straight over the one genuine occurrence that has a badge nearby,
 *     silently reporting 0 tagged images for an entire property. Confirmed by
 *     widening the window to 2000 chars against a live page and getting the
 *     same wrong "0 tagged" result as at 400. Fixed by matching the whole
 *     <img>/<Image> tag with `[^<]*` (safe — HTML attribute values never
 *     contain a literal `<`) up to its own `/>`, so multiple srcset repeats
 *     of the same id collapse into one match, and checking for a badge span
 *     immediately following that specific tag's close.
 *  3. The badge word isn't always immediately followed by `</span>`:
 *     PhotoGrid nests a second "machine-tagged, not yet reviewed" dot <span>
 *     inside the badge whenever taggedBy is a machine tagger, so the word is
 *     usually followed by another `<span`, not the closing tag. Matching
 *     just the word after the opening tag removes that false assumption.
 *  4. Not every image is a .webp — some stored files are .gif — so the
 *     extension is matched generically rather than hardcoded, or those rows
 *     silently drop out of the count entirely (confirmed: one live property
 *     had a `img_....gif` file the `.webp`-only regex never saw).
 */
function extractImages(html) {
  const order = [];
  const tagged = new Map();
  const re = /(img_[0-9a-f]+)\.[a-z0-9]+[^<]*\/>(?:<span[^>]*uppercase[^>]*>([a-z]+))?/g;
  for (const m of html.matchAll(re)) {
    if (!tagged.has(m[1])) {
      order.push(m[1]);
      tagged.set(m[1], false);
    }
    if (m[2] && ROOMS.has(m[2])) tagged.set(m[1], true);
  }
  return order.map((id) => ({ id, tagged: tagged.get(id) }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Politeness: at most 4 in flight, small stagger, sequential-ish batches — the
// live app is concurrently serving another process this round.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      await sleep(50);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const vic = await propsOf("/");
const nsw = await propsOf("/sydney");
// Live (not sold/withdrawn) VIC listings — the same population
// _verify-live.mjs calls liveVic. The 25 frozen NSW rows are already excluded
// by only scoping over `vic` in the first place.
const liveVic = vic.filter((p) => !p.delisted);

console.log(`liveVic: ${liveVic.length} (vicRows ${vic.length}, nswFrozen ${nsw.length})`);

const noFloorplan = [];
// hasExplicitHero cannot be measured from the rendered page at all (see header
// comment) — left empty rather than populated with a guess for every row.
const noExplicitHero = [];
const stillUntagged = [];
let withFloorplan = 0;
let totalUntagged = 0;

let done = 0;
await mapLimit(liveVic, 4, async (p) => {
  const html = await fetch(`${BASE}/property/${p.id}`).then((r) => {
    if (!r.ok) throw new Error(`property/${p.id} -> HTTP ${r.status}`);
    return r.text();
  });

  const hasFloorplan = html.includes(">Floorplan<");
  if (hasFloorplan) withFloorplan++;
  else noFloorplan.push({ id: p.id, address: p.address, imageCount: p.imageCount ?? 0 });

  const imgs = extractImages(html);
  const untagged = imgs.filter((i) => !i.tagged);
  totalUntagged += untagged.length;
  if (untagged.length > 0) {
    stillUntagged.push({ id: p.id, address: p.address, untaggedCount: untagged.length });
  }

  done++;
  if (done % 25 === 0) console.log(`  ...${done}/${liveVic.length}`);
});

const report = {
  base: BASE,
  liveVic: liveVic.length,
  noFloorplan,
  noExplicitHero,
  stillUntagged,
  counts: {
    withFloorplan,
    withExplicitHero: null,
    totalUntagged,
  },
  hasExplicitHeroMeasurable: false,
  note:
    "hasExplicitHero could not be measured from the rendered page: notes='hero' only " +
    "influences which image pickHero() returns server-side; the rendered PhotoGrid badge " +
    "shows roomType, not notes, so an explicit hero and the heuristic-picked hero are " +
    "visually identical on the page. noExplicitHero therefore lists every liveVic property " +
    "with hasExplicitHero: null rather than a guessed proxy signal.",
};

fs.mkdirSync("data/harvest", { recursive: true });
fs.writeFileSync("data/harvest/_audit-hero-floorplan.json", JSON.stringify(report, null, 1));

console.log(JSON.stringify({
  liveVic: liveVic.length,
  withFloorplan,
  noFloorplan: noFloorplan.length,
  withExplicitHero: "not measurable (see note)",
  totalUntagged,
  stillUntaggedRows: stillUntagged.length,
}, null, 1));
