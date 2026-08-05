import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * Process a full-HTML re-fetch payload: {P, d:{<externalId>:{i:[relUrl], s, f, e}}}
 *
 * Domain re-signs every image URL on each capture, so source_url is useless for
 * dedupe across captures — feeding these straight to load:images would clone
 * every photo a property already has. The CDN BASENAME
 * (<listingId>_<photoIndex>_<crop>_<date>...) is stable, so that's the key:
 * only URLs whose basename we don't already hold get downloaded.
 */
const SRC = process.argv[2] ?? "data/harvest/_grab-5.json";
const { P, d } = JSON.parse(fs.readFileSync(SRC, "utf8"));
const db = new Database("data/app.db", { readonly: true });

const byExt = new Map(
  db
    .prepare("SELECT external_id, id, listing_url, address, suburb FROM properties WHERE external_id IS NOT NULL")
    .all()
    .map((r) => [String(r.external_id), r]),
);
const haveOf = db.prepare("SELECT source_url FROM images WHERE property_id = ?");

const toDownload = [];
const statuses = [];
let noProp = 0;

for (const [ext, v] of Object.entries(d)) {
  const p = byExt.get(ext);
  if (!p) {
    noProp++;
    continue;
  }
  statuses.push({
    ext,
    address: p.address,
    suburb: p.suburb,
    status: v.s ?? null,
    profile: !!v.f,
    err: v.e ?? null,
    nUrls: (v.i ?? []).length,
  });
  if (!v.i || !v.i.length) continue;

  const have = new Set(
    haveOf.all(p.id).map((r) => (r.source_url || "").split("/").pop()),
  );
  const fresh = [];
  for (const rel of v.i) {
    const full = rel.startsWith("!") ? rel.slice(1) : P + rel;
    const base = full.split("/").pop();
    if (have.has(base)) continue;
    have.add(base); // guard against dup basenames within one payload
    fresh.push(full);
  }
  if (fresh.length) toDownload.push({ listingUrl: p.listing_url, imageUrls: fresh, _addr: p.address, _n: fresh.length });
}

fs.writeFileSync(
  "data/harvest/_refetch-images.json",
  JSON.stringify(toDownload.map(({ _addr, _n, ...r }) => r), null, 1),
);

console.log("payload properties:", Object.keys(d).length, "| no matching row:", noProp);
console.log("properties with NEW media:", toDownload.length, "| new photos:", toDownload.reduce((a, x) => a + x._n, 0));
for (const t of toDownload) console.log(`   +${String(t._n).padStart(2)}  ${t._addr}`);

console.log("\n--- statuses ---");
for (const s of statuses)
  console.log(
    `   ${s.ext.padEnd(11)} ${String(s.address).slice(0, 30).padEnd(30)} ${String(s.status ?? "-").padEnd(15)} urls=${String(s.nUrls).padStart(2)} ${s.profile ? "[PROFILE-REDIRECT]" : ""} ${s.err ?? ""}`,
  );
fs.writeFileSync("data/harvest/_refetch-status.json", JSON.stringify(statuses, null, 1));
