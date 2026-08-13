// Turn a listing-pass harvest into (a) a gallery load file and (b) a sold /
// withdrawn triage. Reads data/harvest/pass-<n>.json (whatever the receiver
// wrote), writes data/harvest/_gallery-<n>.json and prints the status calls.
//
// Usage: node scripts/_pass-apply.mjs pass-1
import fs from "node:fs";
import Database from "better-sqlite3";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/_pass-apply.mjs <harvest-name>   # e.g. pass-1");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(`data/harvest/${name}.json`, "utf8"));
const db = new Database("data/app.db", { readonly: true });
const propOf = db.prepare("SELECT id, address FROM properties WHERE listing_url = ?");
const haveOf = db.prepare("SELECT source_url FROM images WHERE property_id = ?");
const base = (u) => u.split("/").pop().split("?")[0];

// Domain RE-SIGNS every image URL per capture, so source_url can't detect
// "already have this photo" and syncImages would store the gallery twice. The
// basename (<listingId>_<photoIndex>_<uploadedAt>-wW-hH) IS stable — dedupe on it.
const gallery = [];
const sold = [];
const withdrawn = [];
const problems = [];

for (const [key, v] of Object.entries(raw)) {
  const listingUrl = key.startsWith("http") ? key : "https://www.domain.com.au" + key;
  const prop = propOf.get(listingUrl);
  if (!prop) {
    problems.push({ listingUrl, why: "no property row" });
    continue;
  }
  if (String(v.status).startsWith("error") || v.status === "waf") {
    problems.push({ listingUrl, address: prop.address, why: v.status });
    continue;
  }

  // "withdrawn" = the page redirected to /property-profile/ with no listing.
  // "leased" = the owner relisted it as a RENTAL, so it is off the sale market
  // without having sold. Both belong in scrape_jobs as withdrawn; neither gets a
  // price_history row, because nothing was transacted.
  if (v.status === "withdrawn" || v.status === "leased") {
    withdrawn.push({ listingUrl, address: prop.address, why: v.status });
    continue;
  }

  // Sold ONLY when the price text says so. "Under contract" / "Under offer" is
  // NOT a settled sale — the UI already surfaces that from price_display, and
  // marking it sold hides a listing that is still live.
  const price = v.price || "";
  if (/\bsold\b/i.test(price)) {
    const m = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?/i.exec(price);
    let n = null;
    if (m) {
      const mult = m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1;
      const v2 = Math.round(parseFloat(m[1].replace(/,/g, "")) * mult);
      if (v2 > 10000) n = v2;
    }
    sold.push({ listingUrl, address: prop.address, price: n, raw: price });
  }

  if (v.imgs?.length) {
    const have = new Set(haveOf.all(prop.id).map((r) => base(r.source_url)));
    const fresh = v.imgs.filter((u) => !have.has(base(u)));
    if (fresh.length) gallery.push({ listingUrl, imageUrls: fresh });
  }
}

fs.writeFileSync(`data/harvest/_gallery-${name}.json`, JSON.stringify(gallery, null, 1));
fs.writeFileSync(
  `data/harvest/_status-${name}.json`,
  JSON.stringify({ sold, withdrawn, problems }, null, 1),
);

console.log(
  JSON.stringify({
    listings: Object.keys(raw).length,
    galleriesToLoad: gallery.length,
    newPhotos: gallery.reduce((a, g) => a + g.imageUrls.length, 0),
    sold: sold.length,
    withdrawn: withdrawn.length,
    problems: problems.length,
  }),
);
if (sold.length) {
  console.log("\nSOLD:");
  for (const s of sold) console.log(`  ${s.address} | ${s.price ?? "price withheld"} | "${s.raw}"`);
}
if (withdrawn.length) {
  console.log("\nWITHDRAWN:");
  for (const w of withdrawn) console.log("  " + w.address);
}
if (problems.length) {
  console.log("\nPROBLEMS (re-run these):");
  for (const p of problems) console.log(`  ${p.address ?? p.listingUrl} — ${p.why}`);
}
console.log("\nstill live (no status change), with photo counts:");
for (const g of gallery) console.log(`  ${String(g.imageUrls.length).padStart(3)}  ${g.listingUrl.split("/").pop()}`);
