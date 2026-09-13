// Build the one-call Domain round: `window.__IDS` (what the live app holds)
// prepended to the minified `scripts/browser/domain-full-round.js`.
//
//   node scripts/_snapshot-live.mjs && node scripts/_round-ids.mjs
//
// Writes data/harvest/_round-call.js — paste its contents as the ONE
// javascript_tool call. Ids are sorted and delta-encoded base36 so ~450 of them
// cost ~1.6KB: the call has to stay small or it is auto-denied with no prompt.
import fs from "node:fs";
import assert from "node:assert";
import { execSync } from "node:child_process";

const { rows } = JSON.parse(fs.readFileSync("data/harvest/_snapshot.json", "utf8"));
const idOf = (u) => Number((u.match(/-(\d+)$/) || [])[1] || 0);
const dom = rows.filter((r) => /domain\.com\.au/.test(r.listing_url || "") && idOf(r.listing_url));
const live = new Set(dom.filter((r) => !r.delisted && r.sale_status !== "sold" && r.state === "VIC").map((r) => idOf(r.listing_url)));
const other = new Set(dom.map((r) => idOf(r.listing_url)).filter((id) => !live.has(id)));

const sorted = (s) => [...s].sort((x, y) => x - y);
const enc = (s) => {
  let prev = 0;
  return sorted(s).map((v) => (v - prev).toString(36) + ((prev = v), "")).join(",");
};
// Same decoder as the browser script — the round is only as good as this.
const dec = (s) => {
  let v = 0;
  return s ? s.split(",").map((d) => (v += parseInt(d, 36))) : [];
};
const ids = { a: enc(live), b: enc(other) };
assert.deepEqual(dec(ids.a), sorted(live));
assert.deepEqual(dec(ids.b), sorted(other));

const min = execSync("npx --no-install esbuild scripts/browser/domain-full-round.js --minify --target=chrome120", { encoding: "utf8" });
// --retry=<targets.json> ([{url, why}]) builds a pass-only call instead: the
// listing pages a previous round failed on, no feed or sold search.
const retry = process.argv.find((a) => a.startsWith("--retry="))?.slice("--retry=".length);
const head = retry
  ? `window.__T=${JSON.stringify(JSON.parse(fs.readFileSync(retry, "utf8")).map((t) => [t.url, t.why]))};`
  : `window.__IDS=${JSON.stringify(ids)};`;
const call = head + min.trim();
const out = retry ? "data/harvest/_retry-call.js" : "data/harvest/_round-call.js";
fs.writeFileSync(out, call);
console.log({ out, live: live.size, other: other.size, bytes: call.length });
