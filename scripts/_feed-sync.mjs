// ponytail: turn the compact search-feed harvest into LoadItems + a triage report.
// Usage: node scripts/_feed-sync.mjs [harvestFile]
import fs from "node:fs";

const SRC = process.argv[2] || "data/harvest/feed.json";
const { pages, err, rows } = JSON.parse(fs.readFileSync(SRC, "utf8"));
if (err) console.warn("harvest reported error:", err);

// $-anchored: Domain's price is free text ("Call 0452...", "684sqm", "$865k - $950K").
const parsePrice = (t) => {
  const m = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?/i.exec(t || "");
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1;
  const v = Math.round(n * mult);
  return v > 10000 ? v : null;
};

// house-and-land / off-the-plan (user rule: completed homes only).
// propertyType is the cheap authoritative signal — Domain labels packages
// "New House & Land" / "New Apartments / Off the Plan". The address shapes
// catch the ones re-listed under a tidied address.
const isHnlType = (t) => /^new\s/i.test(t || "") || /off the plan/i.test(t || "");
const isHnlAddress = (a) => /^lot\s/i.test(a) || /turnkey/i.test(a) || /^corner\s/i.test(a) || /\s-\s/.test(a);
// Address withheld AND a single exact price is the package signature: a real
// vendor lists a range or "contact agent", a builder quotes "$715,982" for a
// fixed package. Neither signal alone is enough — "Address By Request" listings
// with a price range are genuine. Caught 4 on 2026-08-15 that typed as "House".
const isPackagePrice = (p) => /^\s*\$[\d,]+\s*$/.test(p || "");

const items = [];
const hnl = [];
const soldish = [];

for (const [url, price, tag, beds, baths, parking, land, street, suburb, postcode, state, lat, lng, insp, ptype] of rows) {
  const listingUrl = "https://www.domain.com.au" + url;
  const externalId = (/-(\d+)$/.exec(url) || [])[1];
  const address = [street, suburb, state, postcode].filter(Boolean).join(", ");
  if (/\bsold\b/i.test(price) || /\bsold\b/i.test(tag)) soldish.push({ listingUrl, street, price, tag });
  if (isHnlType(ptype) || isHnlAddress(street || "") || (!street && isPackagePrice(price))) {
    hnl.push({ listingUrl, street, price, ptype });
    continue; // user rule: completed homes only — never load house-and-land packages
  }
  items.push({
    listingUrl,
    sourceSite: "domain",
    externalId,
    address,
    suburb,
    state,
    postcode,
    priceDisplay: price,
    priceNumeric: parsePrice(price),
    beds,
    baths,
    parking,
    landSizeSqm: land,
    propertyType: ptype || undefined,
    latitude: lat,
    longitude: lng,
    nextInspection: insp ? insp + "+10:00" : null,
  });
}

fs.writeFileSync("data/harvest/feed-items.json", JSON.stringify(items, null, 1));
fs.writeFileSync("data/harvest/feed-triage.json", JSON.stringify({ hnl, soldish }, null, 1));
console.log(
  JSON.stringify(
    {
      pages,
      listings: items.length,
      withPrice: items.filter((i) => i.priceNumeric).length,
      withInspection: items.filter((i) => i.nextInspection).length,
      hnlSuspects: hnl.length,
      soldInFeed: soldish.length,
    },
    null,
    1,
  ),
);
console.log("\nsold-in-feed:");
for (const s of soldish) console.log(" ", s.street, "|", s.price, "|", s.tag);
console.log("\nh&l suspects:");
for (const h of hnl) console.log(" ", h.street);
