// Full coverage scan of the LIVE app, HTTP only — heroes, floorplans, tags.
//
// Supersedes the rendered-badge scan in _audit-hero-floorplan.mjs: this reads
// the exact DB roomType/notes columns out of the RSC flight stream via
// _live-http.mjs, so "has an explicit hero" is answerable (notes='hero'),
// which the badge scan had to report as null.
//
// Inherits _live-http.mjs's one limitation, restated because it matters when
// reading the untagged number: only VISIBLE images reach the client, so an
// image carrying no tag row AND failing the aspect heuristic is invisible to
// any HTTP scan. That can only UNDER-count untagged, never misreport a tag.
//
// Usage: node scripts/_coverage-live.mjs [base]
import fs from "node:fs";
import { getAllLiveProperties, getLiveImages, mapLimit } from "./_live-http.mjs";

const BASE = process.argv[2] || "http://192.168.68.125:3225";

const props = await getAllLiveProperties(BASE);
const rows = [];
let scanned = 0;
await mapLimit(props, 4, async (p) => {
  const imgs = await getLiveImages(BASE, p.id);
  if (++scanned % 100 === 0) console.error(`  scanned ${scanned}/${props.length}`);
  rows.push({
    id: p.id,
    address: p.address,
    delisted: !!p.delisted,
    state: p.state,
    images: imgs.length,
    heroes: imgs.filter((i) => i.notes === "hero").length,
    floorplans: imgs.filter((i) => i.notes === "floorplan").length,
    untagged: imgs.filter((i) => i.roomType == null).length,
  });
});

// The population the user's app actually shows: live VIC listings. The 25
// frozen NSW rows are excluded by standing rule, delisted ones by relevance.
const liveVic = rows.filter((r) => !r.delisted && r.state !== "NSW");
const withPhotos = liveVic.filter((r) => r.images > 0);
const pick = (f) => withPhotos.filter(f).map((r) => ({ id: r.id, address: r.address, images: r.images }));

const out = {
  base: BASE,
  scanned: rows.length,
  liveVic: liveVic.length,
  liveVicWithPhotos: withPhotos.length,
  counts: {
    withExplicitHero: withPhotos.filter((r) => r.heroes > 0).length,
    withFloorplanNote: withPhotos.filter((r) => r.floorplans > 0).length,
    multipleHeroes: withPhotos.filter((r) => r.heroes > 1).length,
    visibleUntagged: rows.reduce((n, r) => n + r.untagged, 0),
    noPhotos: liveVic.filter((r) => r.images === 0).length,
  },
  noExplicitHero: pick((r) => r.heroes === 0),
  noFloorplanNote: pick((r) => r.floorplans === 0),
  multipleHeroes: pick((r) => r.heroes > 1),
};
fs.writeFileSync("data/harvest/_coverage-live.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, noExplicitHero: out.noExplicitHero.length, noFloorplanNote: out.noFloorplanNote.length, multipleHeroes: out.multipleHeroes.length }, null, 1));
