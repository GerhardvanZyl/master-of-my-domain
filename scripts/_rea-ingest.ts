// Turn an REA listing-pass capture into /api/batch payloads.
//
//   npx tsx scripts/_rea-ingest.ts [data/harvest/rea-pass.json]
//
// The capture is RawPageData, so it goes through ReaAdapter.normalize() — the
// same function POST /api/ingest calls for a live extension capture. Nothing
// REA-specific is re-implemented here; if the page shape moves, one adapter and
// its fixture move with it.
//
// Writes:
//   _batch-rea-props.json   properties section (upsert by listing_url, address
//                           twins resolved server-side by load.ts)
//   _batch-rea-images.json  images section, chunk it — each URL is a server-side
//                           download
//   _rea-floorplans.json    listing url -> floorplan CDN hashes. The tagger
//                           cannot infer these (REA puts the plan anywhere in
//                           the reel and the alt text does not say) but the page
//                           states the typename outright, so the note is carried
//                           across from the capture instead of guessed.
import fs from "node:fs";
import { ReaAdapter } from "../src/scrape/adapters/rea";

const SRC = process.argv[2] ?? "data/harvest/rea-pass.json";
const { out, errs } = JSON.parse(fs.readFileSync(SRC, "utf8")) as { out: any[]; errs: any[] };

// The search card's price, as a fallback. The adapter reads the listing page's
// own price text, which is right nearly always — but its pattern wants digits
// straight after the $, and some agents type "$ 690,000 -$ 720,000". The card
// for the same listing parsed fine, so use it rather than loosening a regex
// that a looser form would start matching phone numbers with.
const cardPrice = new Map<string, { display: string; numeric: number | null }>();
try {
  for (const r of JSON.parse(fs.readFileSync("data/harvest/_rea-pass.json", "utf8")) as any[])
    if (r.priceDisplay) cardPrice.set(r.url, { display: r.priceDisplay, numeric: r.priceNumeric });
} catch {
  /* diff output is optional */
}

const props: any[] = [];
const images: { listingUrl: string; imageUrls: string[] }[] = [];
const floorplans: Record<string, string[]> = {};
const partial: string[] = [];
const failed: { url: string; err: string }[] = [...errs.map((e) => ({ url: e.url, err: e.err }))];
const thin: { url: string; n: number }[] = [];

const hashOf = (u: string) => (u.match(/\/([0-9a-f]{32,})\//) || [])[1] ?? u;

for (const raw of out) {
  let r;
  try {
    r = ReaAdapter.normalize(raw);
  } catch (e: any) {
    failed.push({ url: raw.url, err: String(e?.message ?? e) });
    continue;
  }
  const p = r.property;
  const fb = cardPrice.get(raw.url);
  if (!p.priceDisplay && fb) {
    p.priceDisplay = fb.display;
    p.priceNumeric = fb.numeric;
    if (p.address && p.beds != null) p.status = "ok";
  }
  if (p.status !== "ok") partial.push(`${raw.url} — ${p.address ?? "no address"} / ${p.priceDisplay ?? "no price"}`);
  props.push({
    listingUrl: p.listingUrl,
    sourceSite: p.sourceSite,
    externalId: p.externalId ?? undefined,
    address: p.address ?? undefined,
    suburb: p.suburb ?? undefined,
    state: p.state ?? undefined,
    postcode: p.postcode ?? undefined,
    priceDisplay: p.priceDisplay ?? undefined,
    priceNumeric: p.priceNumeric ?? null,
    beds: p.beds ?? null,
    baths: p.baths ?? null,
    parking: p.parking ?? null,
    landSizeSqm: p.landSizeSqm ?? null,
    propertyType: p.propertyType ?? undefined,
    agentName: p.agentName ?? undefined,
    agencyName: p.agencyName ?? undefined,
    description: p.description ?? undefined,
    nextInspection: p.nextInspection ?? null,
    scrapeStatus: p.status,
  });
  // A new listing coming back with one or two photos is a capture failure, not
  // a thin listing — report it rather than storing the gap.
  if (r.images.length <= 2) thin.push({ url: raw.url, n: r.images.length });
  images.push({ listingUrl: p.listingUrl, imageUrls: r.images.map((i) => i.sourceUrl) });
  if (raw.floorplanUrls?.length) floorplans[p.listingUrl] = raw.floorplanUrls.map(hashOf);
}

fs.writeFileSync("data/harvest/_batch-rea-props.json", JSON.stringify({ properties: props }, null, 1));
fs.writeFileSync("data/harvest/_batch-rea-images.json", JSON.stringify({ images }, null, 1));
fs.writeFileSync("data/harvest/_rea-floorplans.json", JSON.stringify(floorplans, null, 1));

console.log({
  captured: out.length,
  properties: props.length,
  photos: images.reduce((n, i) => n + i.imageUrls.length, 0),
  floorplans: Object.values(floorplans).flat().length,
  partial,
  thin,
  failed,
});
