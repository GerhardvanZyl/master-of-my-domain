// End-of-run verification. Everything here is a claim the report will make, so
// it is checked against the DB rather than inferred from what the scripts printed.
import Database from "better-sqlite3";
const db = new Database("data/app.db", { readonly: true });
const one = (s, ...a) => db.prepare(s).get(...a);
const VIC = `(listing_url LIKE '%point-cook-vic-3030%' OR listing_url LIKE '%williams-landing-vic-3027%' OR listing_url LIKE '%torquay-vic-3228%')`;

console.log(
  JSON.stringify(
    {
      properties: one("SELECT COUNT(*) v FROM properties").v,
      images: one("SELECT COUNT(*) v FROM images").v,
      untagged: one(
        "SELECT COUNT(*) v FROM images i LEFT JOIN image_tags t ON t.image_id=i.id WHERE t.room_type IS NULL",
      ).v,
      heroes: one("SELECT COUNT(*) v FROM image_tags WHERE notes='hero'").v,
      heroesFromDomainCover: one(
        "SELECT COUNT(*) v FROM image_tags WHERE notes='hero' AND tagged_by='domain-cover'",
      ).v,
      floorplans: one("SELECT COUNT(*) v FROM image_tags WHERE notes='floorplan'").v,
      priceHistoryRows: one("SELECT COUNT(*) v FROM price_history").v,
      soldRowsToday: one(
        "SELECT COUNT(*) v FROM price_history WHERE event='Sold' AND date=date('now')",
      ).v,
      statusSold: one("SELECT COUNT(*) v FROM scrape_jobs WHERE status='sold'").v,
      statusWithdrawn: one("SELECT COUNT(*) v FROM scrape_jobs WHERE status='withdrawn'").v,
      // Anything still missing the things this job exists to fill:
      vicNoTransit: one(
        `SELECT COUNT(*) v FROM properties WHERE ${VIC} AND pt_minutes_to_flinders IS NULL`,
      ).v,
      vicNoStation: one(`SELECT COUNT(*) v FROM properties WHERE ${VIC} AND nearest_station IS NULL`).v,
      vicNoImages: one(
        `SELECT COUNT(*) v FROM properties p WHERE ${VIC} AND NOT EXISTS (SELECT 1 FROM images i WHERE i.property_id=p.id)`,
      ).v,
      // The frozen NSW rows must be exactly as they were.
      nswRows: one("SELECT COUNT(*) v FROM properties WHERE state='NSW'").v,
      nswWithTransit: one(
        "SELECT COUNT(*) v FROM properties WHERE state='NSW' AND pt_minutes_to_flinders IS NOT NULL",
      ).v,
    },
    null,
    1,
  ),
);

const noHero = db
  .prepare(
    `SELECT p.address, COUNT(i.id) n FROM properties p JOIN images i ON i.property_id=p.id
      WHERE ${VIC} AND NOT EXISTS (
        SELECT 1 FROM image_tags t JOIN images i2 ON i2.id=t.image_id
         WHERE i2.property_id=p.id AND t.notes='hero')
      GROUP BY p.id ORDER BY n DESC LIMIT 10`,
  )
  .all();
console.log(`\nlive VIC properties with photos but no explicit hero: ${noHero.length}`);
for (const r of noHero) console.log("  ", r.address, `(${r.n} imgs)`);
