// Split the single-call Domain round payload into the files the existing
// pipeline already knows how to consume.
//
//   node scripts/_domain-round-split.mjs            # reads data/harvest/domain-round-gz.json
//   node scripts/_domain-round-split.mjs --selftest
//
// Writes:
//   domain-round.json  -> the decoded payload, kept for the record
//   feed.json          -> feed the usual `_feed-sync.mjs`
//   pass-1.json        -> feed the usual `_pass-apply-live.mjs`
//   _sold-search.json  -> a `/api/batch` payload: missing listings found on
//                         Domain's sold search, with the real sale date
//
// `scripts/browser/domain-full-round.js` does the feed, the diff, the sold
// lookup and the listing pass in ONE javascript_tool call, so its output is one
// blob. This converts, so nothing downstream had to change — in particular
// `_pass-apply-live.mjs` keeps ownership of the sold/withdrawn decision for
// listing pages, whose `/^\s*sold\b/` anchor is deliberately stricter than the
// browser's selection filter. Needs a fresh data/harvest/_snapshot.json: the
// browser only knows listing ids, so a missing target comes back as "/<id>"
// and is mapped to its held listing_url here.
import fs from "node:fs";
import zlib from "node:zlib";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Sold-search card -> {price, date}. Price is $-anchored; "Price Withheld" is null. */
export function parseSold(price, tag) {
  const m = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?/i.exec(price || "");
  let n = null;
  if (m) {
    const mult = m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1;
    const v = Math.round(parseFloat(m[1].replace(/,/g, "")) * mult);
    if (v > 10000) n = v;
  }
  const d = /(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})/i.exec(`${tag || ""} ${price || ""}`);
  const mon = d && MONTHS[d[2].toLowerCase()];
  const date = mon ? `${d[3]}-${String(mon).padStart(2, "0")}-${d[1].padStart(2, "0")}` : undefined;
  return { price: n, date };
}

if (process.argv.includes("--selftest")) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cases = [
    [["$850,000", "Sold by private treaty 10 Sep 2026"], { price: 850000, date: "2026-09-10" }],
    [["Price Withheld", "Sold at auction 6 Sep 2026"], { price: null, date: "2026-09-06" }],
    [["$1.05m", "SOLD 04 August 2026"], { price: 1050000, date: "2026-08-04" }],
    [["Call 0452 368 806", ""], { price: null, date: undefined }],
  ];
  let bad = 0;
  for (const [args, want] of cases) {
    const got = parseSold(...args);
    if (!eq(got, want)) {
      bad++;
      console.error("FAIL", JSON.stringify(args), JSON.stringify(got), "want", JSON.stringify(want));
    }
  }
  console.log(bad ? `selftest FAILED (${bad})` : `selftest ok (${cases.length} cases)`);
  process.exit(bad ? 1 : 0);
}

// A retry payload (domain-retry-gz.json) carries only a listing pass: it goes
// to pass-2 and must not overwrite this round's feed or sold-search files.
const SRC = process.argv[2] ?? "data/harvest/domain-round-gz.json";
const PASS = /retry/.test(SRC) ? "pass-2" : "pass-1";
const raw = fs.readFileSync(SRC, "utf8").trim();
const json = zlib.gunzipSync(Buffer.from(decodeURIComponent(raw), "base64")).toString();
fs.writeFileSync(SRC.replace(/-gz\.json$/, ".json"), json);
const P = JSON.parse(json);

const { rows: snap } = JSON.parse(fs.readFileSync("data/harvest/_snapshot.json", "utf8"));
const idOf = (u) => ((u || "").match(/-(\d+)$/) || [])[1];
const heldById = new Map(
  snap.filter((r) => /domain\.com\.au/.test(r.listing_url || "")).map((r) => [idOf(r.listing_url), r.listing_url]),
);
// "/<id>" (a bare-id missing target) -> the listing_url the live app holds.
const urlOf = (t) => (/^\/\d+$/.test(t.url) ? heldById.get(t.url.slice(1)) ?? t.url : t.url);

fs.writeFileSync("data/harvest/feed.json", JSON.stringify({ pages: P.pages, err: P.err, rows: P.feed }));

// _pass-apply-live.mjs keys on the listing URL and reads { status, price, imgs }.
// "unresolved" (a page that parsed but carried no listing) becomes "unknown",
// which it reports as a problem rather than guessing a status.
const pass = {};
for (const r of P.out) {
  const status = r.status === "unresolved" ? "unknown" : r.status ?? "ok";
  pass[urlOf(r)] = { status, price: r.price ?? "", imgs: r.photos ?? [] };
}
for (const e of P.errs) pass[urlOf(e)] = { status: "error:" + e.err, price: "", imgs: [] };
fs.writeFileSync("data/harvest/pass-1.json", JSON.stringify(pass));

const sold = P.sold.map(([id, , price, tag]) => ({ listingUrl: heldById.get(String(id)), ...parseSold(price, tag), raw: `${price} | ${tag}` }));
fs.writeFileSync(
  "data/harvest/_sold-search.json",
  JSON.stringify({ sold: sold.filter((s) => s.listingUrl).map(({ raw: _, ...s }) => s) }, null, 1),
);

const byWhy = {};
for (const t of P.targets) byWhy[t.why] = (byWhy[t.why] ?? 0) + 1;
const byStatus = {};
for (const r of P.out) byStatus[r.status ?? "ok"] = (byStatus[r.status ?? "ok"] ?? 0) + 1;
const thin = P.out.filter((r) => r.why === "new" && (r.photos?.length ?? 0) <= 2);
console.log({
  feedPages: P.pages,
  feedRows: P.feed.length,
  missing: P.missing.length,
  soldOnSearch: sold.length,
  targets: P.targets.length,
  byWhy,
  byStatus,
  errors: P.errs.length,
  photos: P.out.reduce((n, r) => n + (r.photos?.length ?? 0), 0),
  // A new listing coming back with one or two photos is a capture failure, not
  // a thin listing.
  thin: thin.map((r) => ({ url: r.url, n: r.photos?.length ?? 0 })),
  harvestError: P.err,
});
for (const s of sold) console.log("  sold:", s.listingUrl ?? "(unmapped)", s.price, s.date, "|", s.raw);
for (const e of P.errs) console.log("  error:", urlOf(e), e.err);
