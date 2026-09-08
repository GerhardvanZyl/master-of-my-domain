// Split the single-call Domain round payload into the files the existing
// pipeline already knows how to consume.
//
//   node scripts/_domain-round-split.mjs [data/harvest/domain-round.json]
//
// Writes:
//   feed.json      -> feed the usual `_feed-sync.mjs`
//   pass-1.json    -> feed the usual `_pass-apply-live.mjs`
//
// `scripts/browser/domain-full-round.js` does the feed, the diff and the
// listing pass in ONE javascript_tool call, because Domain's JS approval is
// per-call and an operator who has to click every call cannot walk away. That
// makes its output one blob rather than the several harvest files the older
// two-phase flow produced. This converts, so nothing downstream had to change —
// in particular `_pass-apply-live.mjs` keeps ownership of the sold/withdrawn
// decision, whose `/^\s*sold\b/` anchor is deliberately stricter than the
// browser's selection filter.
import fs from "node:fs";

const SRC = process.argv[2] ?? "data/harvest/domain-round.json";
const P = JSON.parse(fs.readFileSync(SRC, "utf8"));

fs.writeFileSync("data/harvest/feed.json", JSON.stringify({ pages: P.pages, err: P.err, rows: P.feed }));

// _pass-apply-live.mjs keys on the listing URL and reads { status, price, imgs }.
const pass = {};
for (const r of P.out) {
  pass[r.url] = { status: r.status ?? "ok", price: r.price ?? "", imgs: r.photos ?? [] };
}
for (const e of P.errs) pass[e.url] = { status: "error:" + e.err, price: "", imgs: [] };
fs.writeFileSync("data/harvest/pass-1.json", JSON.stringify(pass));

const byWhy = {};
for (const t of P.targets) byWhy[t.why] = (byWhy[t.why] ?? 0) + 1;
const thin = P.out.filter((r) => r.why === "new" && (r.photos?.length ?? 0) <= 2);

console.log({
  feedPages: P.pages,
  feedRows: P.feed.length,
  targets: P.targets.length,
  byWhy,
  passed: P.out.length,
  errors: P.errs.length,
  priceChanges: P.priceChanges.length,
  photos: P.out.reduce((n, r) => n + (r.photos?.length ?? 0), 0),
  // A new listing coming back with one or two photos is a capture failure, not
  // a thin listing.
  thin: thin.map((r) => ({ url: r.url, n: r.photos?.length ?? 0 })),
  harvestError: P.err,
});
