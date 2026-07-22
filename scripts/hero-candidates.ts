import Database from "better-sqlite3";
import path from "node:path";

/**
 * For each property that has photos, list the first few landscape (≈3:2)
 * images — the hero candidates — with absolute paths to view. Feeds the
 * "pick a real facade, skip aerials" pass that then calls hero-set.ts.
 *
 * Usage: npx tsx scripts/hero-candidates.ts [--limit=N]
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
);
const limit = args.limit ? Number(args.limit) : Infinity;

const db = new Database("data/app.db");
const IMAGES_DIR = path.resolve("data/images");
const props = db
  .prepare(
    "SELECT DISTINCT property_id FROM images ORDER BY property_id",
  )
  .all() as { property_id: string }[];

const out: unknown[] = [];
for (const { property_id } of props.slice(0, limit)) {
  const p = db
    .prepare("SELECT address FROM properties WHERE id=?")
    .get(property_id) as { address: string | null };
  const imgs = db
    .prepare(
      `SELECT i.id, i.ordinal, i.width, i.height, i.local_path,
              (SELECT notes FROM image_tags t WHERE t.image_id=i.id) AS notes
       FROM images i WHERE i.property_id=? ORDER BY i.ordinal`,
    )
    .all(property_id) as {
    id: string;
    ordinal: number;
    width: number | null;
    height: number | null;
    local_path: string;
    notes: string | null;
  }[];
  // Only landscape shots are plausible heroes; show the first 6.
  const cands = imgs
    .filter((i) => i.width && i.height && i.width >= i.height)
    .slice(0, 6)
    .map((i) => ({
      imageId: i.id,
      ordinal: i.ordinal,
      dims: `${i.width}x${i.height}`,
      absPath: path.join(IMAGES_DIR, property_id, path.basename(i.local_path)),
      notes: i.notes,
    }));
  out.push({ propertyId: property_id, address: p?.address ?? null, candidates: cands });
}
console.log(JSON.stringify(out, null, 1));
