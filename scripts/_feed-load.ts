/**
 * Turn a Domain search-feed harvest (scratchpad/feed.json) into LoadItem[] for
 * `npm run load`. Core fields only, so enrichment/ratings/notes/images survive.
 * ponytail: session helper, hardcoded scratchpad path.
 */
import fs from "node:fs";

const SP =
  "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/771da963-4458-4b1d-b024-700d25a0a9dc/scratchpad";

/**
 * Domain's search `price` is free text ("Call 0452 368 806", "684sqm",
 * "$865k - $950K", "UNDER CONTRACT - $820K"). Anchor on `$` or a phone number /
 * land size is read as the price. First $-token wins; k/m suffixes scale.
 */
function parsePrice(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const suf = (m[2] || "").toLowerCase();
  return suf === "k" ? n * 1000 : suf === "m" ? n * 1e6 : n;
}

type Row = {
  id: number;
  url: string;
  price: string | null;
  beds: number | null;
  baths: number | null;
  cars: number | null;
  ptype: string | null;
  land: number | null;
  lat: number | null;
  lng: number | null;
  sub: string | null;
  pc: string | null;
  st: string | null;
  street: string | null;
  insp: string | null;
};

const feed: Row[] = JSON.parse(fs.readFileSync(SP + "/feed.json", "utf8"));
const items = feed.map((f) => ({
  listingUrl: "https://www.domain.com.au" + f.url,
  sourceSite: "domain",
  externalId: String(f.id),
  address: [f.street, f.sub, f.st, f.pc].filter(Boolean).join(" "),
  suburb: f.sub ?? undefined,
  state: f.st ?? undefined,
  postcode: f.pc ?? undefined,
  priceDisplay: f.price ?? undefined,
  priceNumeric: parsePrice(f.price),
  // undefined, not null: loadProperties treats a key it wasn't sent as "not
  // observed" and leaves the column alone, while an explicit null OVERWRITES.
  // The feed not carrying a land size doesn't mean the house has none — and
  // five of these seven are change-tracked, so a null the twin listing had
  // filled logged a phantom property_changes row per field per round.
  beds: f.beds ?? undefined,
  baths: f.baths ?? undefined,
  parking: f.cars ?? undefined,
  landSizeSqm: f.land || undefined,
  propertyType: f.ptype ?? undefined,
  latitude: f.lat ?? undefined,
  longitude: f.lng ?? undefined,
  nextInspection: f.insp ?? undefined,
}));

fs.writeFileSync(SP + "/loaditems.json", JSON.stringify(items, null, 1));
console.log(
  JSON.stringify({
    items: items.length,
    withPrice: items.filter((i) => i.priceNumeric != null).length,
    withInspection: items.filter((i) => i.nextInspection).length,
  }),
);
