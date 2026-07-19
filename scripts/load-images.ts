import "../src/lib/load-env";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { migrate } from "../src/db/migrate";
import { db } from "../src/db/client";
import { properties } from "../src/db/schema";
import { syncImages } from "../src/scrape/images";

/**
 * Download listing photos gathered by browsing into data/images/<propertyId>/
 * and insert image rows (via the app's own syncImages — dedupes, sizes, keeps
 * existing tags). Input JSON: [{ listingUrl, imageUrls: [url, ...] }].
 * Idempotent — already-downloaded source URLs are kept.
 * Usage: npm run load:images -- <file.json>
 */
const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run load:images -- <file.json>");
  process.exit(1);
}
migrate();

const items: { listingUrl: string; imageUrls: string[] }[] = JSON.parse(
  fs.readFileSync(file, "utf8"),
);

for (const it of items) {
  const prop = db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.listingUrl, it.listingUrl))
    .get();
  if (!prop) {
    console.error("no property for", it.listingUrl);
    continue;
  }
  const norm = (it.imageUrls ?? []).map((sourceUrl, ordinal) => ({
    sourceUrl,
    ordinal,
  }));
  const res = await syncImages(prop.id, norm, it.listingUrl);
  console.log(prop.id, it.listingUrl.split("/").pop(), JSON.stringify(res));
}
