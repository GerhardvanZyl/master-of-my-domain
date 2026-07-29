import "../src/lib/load-env";
import { randomUUID } from "node:crypto";
import { parseFlags } from "../src/lib/args";
import { sqlite } from "../src/db/client";

/**
 * Sanctioned write path for marking a Domain listing sold — replaces
 * hand-writing another _apply-status*.ts session script. Sets scrape_jobs
 * status='sold' for the listing and appends a dated price_history 'Sold' row,
 * with a price if known or none for price-withheld sales ("SOLD by X!" /
 * "SOLD - Price Withheld") — the sold DATE must survive even when the price
 * doesn't (see soldDate() in src/scrape/adapters/domain.ts, which can probe a
 * captured payload for the date to pass here).
 *
 * Idempotent: clears any prior sold/withdrawn/delisted scrape_jobs row for the
 * url and any prior 'Sold' price_history row for the property before
 * inserting, so re-running (e.g. to correct --price/--date) replaces in place
 * rather than accumulating. Domain's own historical sale timeline (previous
 * owners, ingested separately) uses different event text ("Sold - PRIVATE
 * TREATY" etc.) so those rows are untouched.
 *
 * Run: npm run mark-sold -- --url=<listingUrl> --price=<number|none> [--date=YYYY-MM-DD]
 *   or: npm run mark-sold -- --external=<externalId> --price=<number|none> [--date=YYYY-MM-DD]
 * --date defaults to today (detection date) when the real sale date isn't known.
 */
const f = parseFlags(process.argv.slice(2));
const url = typeof f.url === "string" ? f.url : "";
const external = typeof f.external === "string" ? f.external : "";
const priceArg = typeof f.price === "string" ? f.price : "";
const dateArg = typeof f.date === "string" ? f.date : "";

function usageError(msg: string): never {
  console.error(
    `${msg}\nUsage: npm run mark-sold -- --url=<listingUrl> --price=<number|none> [--date=YYYY-MM-DD]\n` +
      "   or: npm run mark-sold -- --external=<externalId> --price=<number|none> [--date=YYYY-MM-DD]",
  );
  process.exit(1);
}

if (!url && !external) usageError("Need --url=<listingUrl> or --external=<externalId>.");
if (!priceArg) usageError('Need --price=<number> or --price=none.');
if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
  usageError(`--date must be YYYY-MM-DD, got "${dateArg}".`);
}

const price = priceArg === "none" ? null : Number(priceArg);
if (price != null && (!Number.isFinite(price) || price <= 0)) {
  usageError(`--price must be a positive number or "none", got "${priceArg}".`);
}

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const date = dateArg || today;

const prop = url
  ? (sqlite
      .prepare("SELECT id, listing_url u FROM properties WHERE listing_url = ?")
      .get(url) as { id: string; u: string } | undefined)
  : (sqlite
      .prepare("SELECT id, listing_url u FROM properties WHERE external_id = ?")
      .get(external) as { id: string; u: string } | undefined);

if (!prop) {
  console.error(
    `No property found for ${url ? `url "${url}"` : `external id "${external}"`}.`,
  );
  process.exit(1);
}

sqlite
  .prepare(
    "DELETE FROM scrape_jobs WHERE url = ? AND status IN ('delisted','sold','withdrawn')",
  )
  .run(prop.u);
sqlite
  .prepare(
    "INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?, ?, 'sold', ?, ?, ?)",
  )
  .run(randomUUID(), prop.u, prop.id, now, now);

sqlite
  .prepare("DELETE FROM price_history WHERE property_id = ? AND event = 'Sold'")
  .run(prop.id);
const priceDisplay = price != null ? "Sold - $" + price.toLocaleString("en-AU") : null;
sqlite
  .prepare(
    "INSERT INTO price_history (id, property_id, date, event, price_display, price_numeric, created_at) VALUES (?, ?, ?, 'Sold', ?, ?, ?)",
  )
  .run(randomUUID(), prop.id, date, priceDisplay, price, now);

console.log(JSON.stringify({ ok: true, propertyId: prop.id, url: prop.u, price, date }));
