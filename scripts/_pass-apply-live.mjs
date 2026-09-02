// Same job as _pass-apply.mjs — turn a listing-pass harvest into a gallery load
// file plus a sold/withdrawn triage — but resolved against the LIVE app instead
// of the local data/app.db.
//
// Why: the local DB is deliberately never written, so it lags a full round. The
// 28 listings this round just inserted on .125 do not exist locally, and
// _pass-apply.mjs would drop every one of them as "no property row".
//
// Usage: node scripts/_pass-apply-live.mjs pass-1
// Requires a fresh data/harvest/_snapshot.json (scripts/_snapshot-live.mjs).
import fs from "node:fs";

/**
 * Does this Domain price string mean the property actually sold?
 * Exported shape kept trivial so the self-check below can exercise it.
 */
export const isSoldPrice = (price) => /^\s*sold\b/i.test(price || "");

// node scripts/_pass-apply-live.mjs --selftest
if (process.argv[2] === "--selftest") {
  const cases = [
    ["SOLD - $920,000", true],
    ["SOLD - Price Withheld", true],
    ["Sold", true],
    ["sold - $731,000", true],
    ["Offers Closing 21/9/26 @ 5pm (If not Sold Prior)", false], // the live Torquay listing
    ["Auction Sat 20/9 (Unless Sold Prior)", false],
    ["$850,000 - $900,000", false],
    ["Under Offer", false],
    ["Contact Agent", false],
    ["", false],
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = isSoldPrice(input);
    if (got !== want) {
      bad++;
      console.error(`FAIL ${JSON.stringify(input)} -> ${got}, want ${want}`);
    }
  }
  console.log(bad ? `selftest FAILED (${bad})` : `selftest ok (${cases.length} cases)`);
  process.exit(bad ? 1 : 0);
}


const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/_pass-apply-live.mjs <harvest-name>   # e.g. pass-1");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(`data/harvest/${name}.json`, "utf8"));
const snap = JSON.parse(fs.readFileSync("data/harvest/_snapshot.json", "utf8"));

const norm = (u) => (u || "").replace(/\/+$/, "").toLowerCase();
const byUrl = new Map(snap.rows.filter((r) => /^https?:/.test(r.listing_url || "")).map((r) => [norm(r.listing_url), r]));
const base = (u) => u.split("/").pop().split("?")[0];

const gallery = [];
const sold = [];
const withdrawn = [];
const problems = [];
const skippedHavePhotos = [];

for (const [key, v] of Object.entries(raw)) {
  const listingUrl = key.startsWith("http") ? key : "https://www.domain.com.au" + key;
  const prop = byUrl.get(norm(listingUrl));
  if (!prop) {
    problems.push({ listingUrl, why: "no property row on the live app" });
    continue;
  }
  if (String(v.status).startsWith("error") || v.status === "waf" || v.status === "unknown") {
    problems.push({ listingUrl, address: prop.address, why: v.status });
    continue;
  }

  // "withdrawn" = redirected to /property-profile/ with no listing.
  // "leased" = relisted as a RENTAL, so off the sale market without selling.
  // Both are scrape_jobs withdrawn; neither gets a price_history row.
  if (v.status === "withdrawn" || v.status === "leased") {
    withdrawn.push({ listingUrl, address: prop.address, why: v.status });
    continue;
  }

  // Sold ONLY when the price text says so. "Under contract"/"Under offer" is not
  // a settled sale and marking it sold hides a listing that is still live.
  //
  // ANCHORED AT THE START, deliberately. A bare /\bsold\b/ also fires on the
  // auction idiom "Offers Closing 21/9/26 @ 5pm (If not Sold Prior)" — a LIVE
  // listing — and marking that sold delists a property still for sale. Every
  // real sold price Domain serves leads with the word: "SOLD - $920,000",
  // "SOLD - Price Withheld", or plain "Sold" (47 Yacht Rd, status underOffer).
  // Failing closed here is the safe direction: a missed sale is caught next
  // round, a false sale hides a live listing until someone notices.
  const price = v.price || "";
  if (isSoldPrice(price)) {
    const m = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?/i.exec(price);
    let n = null;
    if (m) {
      const mult = m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1;
      const v2 = Math.round(parseFloat(m[1].replace(/,/g, "")) * mult);
      if (v2 > 10000) n = v2;
    }
    sold.push({ listingUrl, address: prop.address, price: n, raw: price });
  }

  if (!v.imgs?.length) continue;

  // syncImages dedupes on source_url and Domain re-signs every URL per capture,
  // so re-sending a property that already has photos stores the gallery TWICE.
  // The live snapshot gives image_count but not basenames, so the safe rule is
  // the one that has always applied: only ever load galleries for zero-photo
  // properties. Anything else is reported, not silently dropped.
  if (prop.image_count > 0) {
    skippedHavePhotos.push({ address: prop.address, have: prop.image_count, offered: v.imgs.length });
    continue;
  }

  // One listing re-uploaded over time carries the SAME photo slot under several
  // dates (26 Kittyhawk had _2_1_251209_, _2_1_260119_, _2_1_260505_). Basenames
  // differ, so a basename dedupe keeps them all and the gallery fills with
  // near-duplicates. Keep one per <listingId>_<photoIndex>_<crop>, newest upload.
  const bySlot = new Map();
  for (const u of v.imgs) {
    const b = base(u);
    const m = /^(\d+)_(\d+)_(\d+)_(\d+)_(\d+)/.exec(b);
    const k = m ? `${m[1]}_${m[2]}_${m[3]}` : b;
    const stamp = m ? `${m[4]}${m[5]}` : "";
    const prev = bySlot.get(k);
    if (!prev || stamp > prev.stamp) bySlot.set(k, { u, stamp });
  }
  // Drop what the app would never render anyway. isPropertyPhoto() rejects
  // squares (agent cards / agency logos), banner strips and icons; those slip in
  // via the page-HTML source, get stored, and then sit permanently untagged
  // because the property page never lists them for the tagger to reach.
  // Dimensions are in the basename as -w<W>-h<H>.
  const renderable = (u) => {
    const m = /-w(\d+)-h(\d+)(?:\.|$)/.exec(base(u));
    if (!m) return true; // unknown size — let the app decide
    const w = +m[1], h = +m[2];
    const a = w / h;
    if (Math.max(w, h) < 500) return false;
    if (a >= 2.2 || a <= 0.45) return false;
    return !(a > 0.95 && a < 1.05);
  };
  const deduped = [...bySlot.values()].map((x) => x.u).filter(renderable);
  gallery.push({ listingUrl, imageUrls: deduped });
}

fs.writeFileSync(`data/harvest/_gallery-${name}.json`, JSON.stringify(gallery, null, 1));
fs.writeFileSync(
  `data/harvest/_status-${name}.json`,
  JSON.stringify({ sold, withdrawn, problems, skippedHavePhotos }, null, 1),
);

console.log(
  JSON.stringify({
    listings: Object.keys(raw).length,
    galleriesToLoad: gallery.length,
    newPhotos: gallery.reduce((a, g) => a + g.imageUrls.length, 0),
    sold: sold.length,
    withdrawn: withdrawn.length,
    problems: problems.length,
    skippedHavePhotos: skippedHavePhotos.length,
  }),
);
if (sold.length) {
  console.log("\nSOLD:");
  for (const s of sold) console.log(`  ${s.address} | ${s.price ?? "price withheld"} | "${s.raw}"`);
}
if (withdrawn.length) {
  console.log("\nWITHDRAWN:");
  for (const w of withdrawn) console.log(`  ${w.address} (${w.why})`);
}
if (problems.length) {
  console.log("\nPROBLEMS (re-run these):");
  for (const p of problems) console.log(`  ${p.address ?? p.listingUrl} — ${p.why}`);
}
console.log("\ngalleries to load (photo counts — a NEW listing at 1-2 is a capture failure):");
for (const g of gallery) console.log(`  ${String(g.imageUrls.length).padStart(3)}  ${g.listingUrl.split("/").pop()}`);
