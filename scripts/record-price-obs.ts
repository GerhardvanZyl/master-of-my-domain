import "../src/lib/load-env";
import { randomUUID } from "node:crypto";
import { sqlite } from "../src/db/client";

/**
 * Append-only price observations — OUR OWN record of each listing's price over
 * time, independent of Domain's supplied timeline. Run after every update/sync
 * (see the processing-round memory): for each active domain listing, if its
 * current price differs from the most-recently-recorded price, insert a dated
 * "Price observed" row. Idempotent — re-running the same day adds nothing.
 *
 * Run: npx tsx scripts/record-price-obs.ts   (or: npm run price:observe)
 */
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const props = sqlite
  .prepare(
    `SELECT id, price_display AS pd, price_numeric AS pn FROM properties
      WHERE (source_site = 'domain' OR listing_url LIKE '%domain%')
        AND price_display IS NOT NULL
        AND listing_url NOT IN (SELECT url FROM scrape_jobs WHERE status = 'delisted')`,
  )
  .all() as { id: string; pd: string; pn: number | null }[];

const latest = sqlite.prepare(
  "SELECT price_display AS pd FROM price_history WHERE property_id = ? ORDER BY date DESC, created_at DESC LIMIT 1",
);
const insert = sqlite.prepare(
  "INSERT INTO price_history (id, property_id, date, event, price_display, price_numeric, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

let added = 0;
for (const p of props) {
  const prev = latest.get(p.id) as { pd: string | null } | undefined;
  if (!prev || prev.pd !== p.pd) {
    insert.run(randomUUID(), p.id, today, "Price observed", p.pd, p.pn, now);
    added++;
  }
}
console.log(JSON.stringify({ observed: today, scanned: props.length, added }));
