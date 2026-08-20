// Rebuild the full image URLs a compressed listing-pass harvest carries, so
// _pass-apply.mjs sees the flat {listingUrl: {status, price, imgs:[url]}} shape
// it always has. Idempotent: an already-flat file is left alone.
//
// Usage: node scripts/_pass-expand.mjs pass-1
//        node scripts/_pass-expand.mjs --selftest
import fs from "node:fs";

const P = "https://rimh2.domainstatic.com.au/";
const expand = (s, tf) => {
  if (s.startsWith("!")) return s.slice(1);
  const [sig, k, bn] = s.split("|");
  return P + sig + tf[+k] + "/" + bn;
};

// ponytail: the pack/unpack pair is the only non-trivial logic here — a wrong
// rebuild silently 403s every image, so it gets one runnable check.
if (process.argv.includes("--selftest")) {
  const t = "/fit-in/5760x3240/filters:format(webp):quality(80):no_upscale()";
  const bn = "2020862706_24_3_260522_033425-w1200-h1200";
  const got = expand(`paBsfzgzqoi8vdyubWDwnCwU0So=|0|${bn}`, [t]);
  const want = `${P}paBsfzgzqoi8vdyubWDwnCwU0So=${t}/${bn}`;
  if (got !== want) throw new Error(`round-trip failed:\n  got  ${got}\n  want ${want}`);
  if (expand("!https://other.example/x.jpg", []) !== "https://other.example/x.jpg")
    throw new Error("passthrough failed");
  console.log("selftest ok");
  process.exit(0);
}

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/_pass-expand.mjs <harvest-name>   # e.g. pass-1");
  process.exit(1);
}
const path = `data/harvest/${name}.json`;
const raw = JSON.parse(fs.readFileSync(path, "utf8"));
if (!raw.tf || !raw.d) {
  console.log("already expanded (no tf/d wrapper) — nothing to do");
  process.exit(0);
}

const out = {};
let urls = 0;
for (const [k, v] of Object.entries(raw.d)) {
  out[k] = v.imgs ? { ...v, imgs: v.imgs.map((s) => expand(s, raw.tf)) } : v;
  urls += v.imgs?.length ?? 0;
}
fs.writeFileSync(path, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ listings: Object.keys(out).length, urls, transforms: raw.tf.length }));
