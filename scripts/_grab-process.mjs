import fs from "node:fs";
import Database from "better-sqlite3";

const db = new Database("data/app.db");
const SRC = process.argv[2] ?? "data/harvest/_grab-0.json";
const { P, Q, d } = JSON.parse(fs.readFileSync(SRC, "utf8"));
console.log("source:", SRC);

const byExt = new Map(
  db
    .prepare("SELECT external_id, id, listing_url, address FROM properties WHERE external_id IS NOT NULL")
    .all()
    .map((r) => [String(r.external_id), r]),
);
const imgCount = new Map(
  db.prepare("SELECT property_id, COUNT(*) n FROM images GROUP BY property_id").all().map((r) => [r.property_id, r.n]),
);

const images = [];
const status = [];
let noProp = 0;
let skippedHasImages = 0;

for (const [ext, v] of Object.entries(d)) {
  const prop = byExt.get(ext);
  if (!prop) {
    noProp++;
    continue;
  }
  if (v.i && v.i.length) {
    if ((imgCount.get(prop.id) ?? 0) > 0) {
      skippedHasImages++;
    } else {
      const urls = v.i.map((s) => {
        if (s.startsWith("!")) return s.slice(1);
        const [sig, suffix] = s.split("~");
        return P + sig + Q + ext + "_" + suffix;
      });
      images.push({ listingUrl: prop.listing_url, imageUrls: urls });
    }
  }
  if (v.p || v.s || v.f) {
    status.push({ ext, address: prop.address, price: v.p ?? null, status: v.s ?? null, isProfile: !!v.f, err: v.e ?? null });
  }
}

fs.writeFileSync("data/harvest/_grab-images.json", JSON.stringify(images, null, 1));
fs.writeFileSync("data/harvest/_grab-status.json", JSON.stringify(status, null, 1));

console.log("collected properties:", Object.keys(d).length);
console.log("no matching property row:", noProp);
console.log("skipped (already had images):", skippedHasImages);
console.log("image sets to download:", images.length, "photos:", images.reduce((a, x) => a + x.imageUrls.length, 0));
console.log("status records:", status.length);
console.log("\nsample url:", images[0]?.imageUrls[0]);
console.log("\nstatus lines:");
for (const s of status) console.log("  ", s.ext, (s.address || "?").slice(0, 34).padEnd(34), "|", s.status, "|", (s.price || "").slice(0, 44), s.isProfile ? "[PROFILE-REDIRECT]" : "");
