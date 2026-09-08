// Mark each REA listing's floorplan on the live app, from what the capture
// recorded rather than from a shape guess.
//
//   node scripts/_rea-floorplan-mark.mjs [floorplans.json] [out.json]
//
// Domain puts its floorplan last, so position identifies it. REA's sits
// anywhere in the reel and its alt text does not say, which is why the room
// tagger deliberately refuses to guess one — a guess mislabels hallways. But
// the REA listing page types it outright (`MediaFloorplan`, a separate GraphQL
// node from `MediaImage`), so `_rea-ingest.ts` records which CDN hashes are
// floorplans and this turns that into a tag row.
//
// Matched on the CDN hash in the stored `sourceUrl`, not on position: the
// capture does append floorplans last, but syncImages can drop an image, and a
// positional match would then silently mark the wrong photo.
//
// It also marks the cover. For REA, ordinal 0 IS the hero — pickHero ranks
// through urlIds(), which parses Domain's filename convention and returns null
// for REA — so the app renders it correctly either way, but `_verify-live.mjs`
// checks for an explicit notes='hero' and would report every REA row as a
// listing with photos and no hero. Marking it makes the implicit rule visible.
//
// Run this AFTER the room tagger, never before: the tagger skips any image
// whose notes are 'hero' or 'floorplan' (rewriting them would drop the note),
// so marking first would leave both photos permanently unclassified.
import fs from "node:fs";
import { getAllLiveProperties, getLiveImages } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const SRC = process.argv[2] ?? "data/harvest/_rea-floorplans.json";
const OUT = process.argv[3] ?? "data/harvest/_batch-rea-floorplan.json";

const want = JSON.parse(fs.readFileSync(SRC, "utf8")); // listingUrl -> [hash]
const props = await getAllLiveProperties(BASE);
const byUrl = new Map(props.map((p) => [p.listingUrl, p]));

const tags = [];
const misses = [];
for (const [listingUrl, hashes] of Object.entries(want)) {
  const p = byUrl.get(listingUrl);
  if (!p) {
    misses.push({ listingUrl, why: "no live property" });
    continue;
  }
  const imgs = await getLiveImages(BASE, p.id);
  // Keep whatever the model called each one — the note is what the app reads,
  // and overwriting the room type with a coarser verdict loses information for
  // nothing.
  const mark = (im, notes) =>
    tags.push({
      imageId: im.id,
      roomType: im.roomType ?? "other",
      notes,
      taggedBy: "rule",
      confidence: 1,
      ifAbsent: false,
    });

  const cover = imgs.find((i) => i.ordinal === 0);
  if (cover && cover.notes !== "hero") mark(cover, "hero");
  else if (!cover) misses.push({ listingUrl, why: "no ordinal-0 image" });

  for (const h of hashes) {
    const im = imgs.find((i) => (i.sourceUrl ?? "").includes(h));
    if (!im) {
      misses.push({ listingUrl, hash: h.slice(0, 12), why: "no image with that hash" });
      continue;
    }
    mark(im, "floorplan");
  }
}

fs.writeFileSync(OUT, JSON.stringify({ tags }, null, 1));
console.log({ listings: Object.keys(want).length, marked: tags.length, misses, out: OUT });
