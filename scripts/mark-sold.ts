import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { markSold } from "../src/db/queries/status";

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

const date = dateArg || new Date().toISOString().slice(0, 10);

// The write itself lives in src/db/queries/status.ts so that
// POST /api/batch { sold: [...] } against the live app records the same rows.
try {
  const res = markSold({
    listingUrl: url || undefined,
    externalId: external || undefined,
    price,
    date,
  });
  console.log(JSON.stringify({ ...res, price, date }));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
