// Build the per-listing pass target list + print the JS to paste into the
// Domain tab. ONE paced loop covers every reason we need a listing page:
//   new       -> full gallery incl. the floorplan galleryV2 omits
//   missing   -> sold vs withdrawn, and the sale price
//   soldish   -> in-feed listings whose price text says SOLD
//   junkprice -> price_display Domain served as unusable free text
import fs from "node:fs";

const diff = JSON.parse(fs.readFileSync("data/harvest/_diff.json", "utf8"));
const triage = JSON.parse(fs.readFileSync("data/harvest/feed-triage.json", "utf8"));
const extOf = (u) => (/-(\d+)$/.exec(u) || [])[1];

const targets = new Map();
const add = (url, why) => {
  const ext = extOf(url);
  if (!ext) return;
  if (targets.has(url)) targets.get(url).why.push(why);
  else targets.set(url, { url, ext, why: [why] });
};

for (const r of diff.neu) add(r.listing_url, "new");
for (const r of diff.missing) add(r.listing_url, "missing");
for (const s of triage.soldish) add(s.listingUrl, "soldish");
// Listings whose advertised price is unusable free text ("But", "Contact Agent"
// is fine — that one is a real state) get re-read from their own page.
for (const r of diff.changed) if ((r.price_display || "").trim().length < 5) add(r.listing_url, "junkprice");

const list = [...targets.values()];
fs.writeFileSync("data/harvest/_pass-targets.json", JSON.stringify(list, null, 1));

// ~14 per chunk: at ~25 photos x ~172 chars a listing, more than that overflows
// what a hash-bridge navigation reliably carries back.
const CHUNK = Number(process.argv[2] || 14);
const tpl = fs.readFileSync("scripts/browser/listing-pass.js", "utf8");
const chunks = [];
for (let i = 0; i < list.length; i += CHUNK) {
  const part = list.slice(i, i + CHUNK);
  const n = chunks.length + 1;
  fs.writeFileSync(
    `data/harvest/_pass-${n}.js`,
    tpl.replace("__TARGETS__", JSON.stringify(part.map((t) => [t.url, t.ext]))),
  );
  chunks.push({ chunk: n, listings: part.length, minutes: Math.round((part.length * 45) / 60) });
}

console.log(
  JSON.stringify(
    {
      targets: list.length,
      new: list.filter((t) => t.why.includes("new")).length,
      missing: list.filter((t) => t.why.includes("missing")).length,
      soldish: list.filter((t) => t.why.includes("soldish")).length,
      junkprice: list.filter((t) => t.why.includes("junkprice")).length,
      chunks,
    },
    null,
    1,
  ),
);
