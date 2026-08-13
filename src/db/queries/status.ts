import { randomUUID } from "node:crypto";
import { sqlite } from "../client";

/**
 * Sale-status and price-observation writes, shared by the CLIs (`mark-sold`,
 * `price:observe`) and the HTTP batch endpoint. Both callers must behave
 * identically — a sync run against the live app over HTTP has to leave the same
 * rows behind as the same run driven locally, or the two DBs diverge.
 *
 * DELISTED_STATUSES in the properties query treats sold/withdrawn/delisted as
 * "not live", so these rows drive the grid + detail badges.
 */

function findProperty(ref: { listingUrl?: string; externalId?: string }) {
  if (ref.listingUrl) {
    const r = sqlite
      .prepare("SELECT id, listing_url u FROM properties WHERE listing_url = ?")
      .get(ref.listingUrl) as { id: string; u: string } | undefined;
    if (r) return r;
  }
  if (ref.externalId) {
    return sqlite
      .prepare("SELECT id, listing_url u FROM properties WHERE external_id = ?")
      .get(ref.externalId) as { id: string; u: string } | undefined;
  }
  return undefined;
}

/** Replace any prior sold/withdrawn/delisted job row for this url with one. */
function setJobStatus(url: string, propertyId: string, status: string) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "DELETE FROM scrape_jobs WHERE url = ? AND status IN ('delisted','sold','withdrawn')",
    )
    .run(url);
  sqlite
    .prepare(
      "INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(randomUUID(), url, status, propertyId, now, now);
}

/**
 * Mark a listing sold. `price` null records a price-withheld sale — the sold
 * DATE must survive even when the price doesn't. `date` defaults to today, the
 * detection date; pass the real sale date when it's known, because a row alone
 * can't tell the two apart afterwards.
 *
 * Idempotent: re-running replaces the job row and the 'Sold' price_history row
 * in place. Domain's own ingested sale timeline uses different event text
 * ("Sold - PRIVATE TREATY") and is left alone.
 */
export function markSold(input: {
  listingUrl?: string;
  externalId?: string;
  price?: number | null;
  date?: string;
}): { ok: true; propertyId: string; url: string } {
  const prop = findProperty(input);
  if (!prop) throw new Error(`No property for ${input.listingUrl ?? input.externalId}`);
  const price = input.price ?? null;
  if (price != null && (!Number.isFinite(price) || price <= 0)) {
    throw new Error(`price must be a positive number or null, got ${price}`);
  }
  const date = input.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);

  setJobStatus(prop.u, prop.id, "sold");
  sqlite.prepare("DELETE FROM price_history WHERE property_id = ? AND event = 'Sold'").run(prop.id);
  sqlite
    .prepare(
      "INSERT INTO price_history (id, property_id, date, event, price_display, price_numeric, created_at) VALUES (?, ?, ?, 'Sold', ?, ?, ?)",
    )
    .run(
      randomUUID(),
      prop.id,
      date,
      price != null ? "Sold - $" + price.toLocaleString("en-AU") : null,
      price,
      new Date().toISOString(),
    );
  return { ok: true, propertyId: prop.id, url: prop.u };
}

/**
 * Mark a listing withdrawn — it left the feed and its page redirects to
 * /property-profile/ with no listingModel, which is what distinguishes it from
 * a sale. No price_history row: nothing was transacted.
 */
export function markWithdrawn(input: {
  listingUrl?: string;
  externalId?: string;
}): { ok: true; propertyId: string; url: string } {
  const prop = findProperty(input);
  if (!prop) throw new Error(`No property for ${input.listingUrl ?? input.externalId}`);
  setJobStatus(prop.u, prop.id, "withdrawn");
  return { ok: true, propertyId: prop.id, url: prop.u };
}

/**
 * Our OWN dated price record, independent of Domain's supplied timeline: for
 * each active domain listing whose current price differs from the last recorded
 * one, append a "Price observed" row. Idempotent — re-running the same day adds
 * nothing.
 *
 * Deliberately append-only. Never do this with a `loadProperties` priceHistory
 * array instead: that path dedupes but a full core load rewrites raw_json, and
 * earlier versions replaced history wholesale and wiped Domain's timeline.
 */
export function recordPriceObservations(): {
  observed: string;
  scanned: number;
  added: number;
} {
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
  return { observed: today, scanned: props.length, added };
}
