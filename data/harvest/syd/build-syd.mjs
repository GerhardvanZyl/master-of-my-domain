import { readFileSync, writeFileSync, readdirSync } from "node:fs";

// Merge all part-*.json (each an object or array of {item,imageUrls}) by
// listingUrl, clean image lists, and emit cap.json + syd-core.json (LoadItems)
// + syd-images.json ([{listingUrl,imageUrls}]) for the loaders.
const dir = new URL("./", import.meta.url);
const files = readdirSync(dir).filter((f) => /^part-.*\.json$/.test(f)).sort();

const JUNK = /\/(contact_|logo_)|\/Agencys\/|\.svg(\?|$)|_next\/static|BYB-logo|domain-insight|fe-static|fe-co-brand|Spot_Compact_Calendar/i;
function cleanImages(urls) {
  const kept = (urls || []).filter((u) => !JUNK.test(u));
  const byKey = new Map();
  for (const u of kept) {
    const m = u.match(/\/(\d{6,}_\d+)_\d+_/);
    const key = m ? m[1] : u;
    if (!byKey.has(key)) byKey.set(key, u);
  }
  return [...byKey.values()];
}

const byUrl = new Map();
for (const f of files) {
  const d = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  for (const rec of Array.isArray(d) ? d : [d]) {
    if (rec?.item?.listingUrl) byUrl.set(rec.item.listingUrl, rec);
  }
}
const recs = [...byUrl.values()];
const cap = recs.map((r) => ({ item: r.item, imageUrls: cleanImages(r.imageUrls) }));
const core = cap.map((r) => r.item);
const images = cap.map((r) => ({ listingUrl: r.item.listingUrl, imageUrls: r.imageUrls }));

writeFileSync(new URL("./cap.json", dir), JSON.stringify(cap, null, 0));
writeFileSync(new URL("./syd-core.json", dir), JSON.stringify(core, null, 0));
writeFileSync(new URL("./syd-images.json", dir), JSON.stringify(images, null, 0));
console.log(JSON.stringify({
  parts: files.length,
  merged: cap.length,
  totalImages: images.reduce((s, x) => s + x.imageUrls.length, 0),
  perListing: cap.map((r) => `${r.item.address.split(",")[0]}=${r.imageUrls.length}`),
}, null, 1));
