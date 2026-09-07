import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../client";
import { properties, images, propertyChanges } from "../schema";
import { getSaleStatus } from "./properties";

/**
 * Flat snapshot of the fields tracked for the property-change history — see
 * FIELD_NAMES below for the field name each one is logged under. `saleStatus`
 * reuses getSaleStatus() (queries/properties.ts) rather than re-deriving
 * "delisted" from scrape_jobs a second time; `photos` is a live COUNT(*), not
 * a column.
 */
export interface ChangeSnapshot {
  priceDisplay: string | null;
  priceNumeric: number | null;
  nextInspection: string | null;
  beds: number | null;
  baths: number | null;
  parking: number | null;
  landSizeSqm: number | null;
  propertyType: string | null;
  address: string | null;
  agentName: string | null;
  agencyName: string | null;
  saleStatus: string | null;
  photos: number;
}

// The one map that decides which fields are tracked and what they're called in
// a property_changes row. "listing" (a property appearing at all) isn't here —
// it has no before value to diff, and is handled directly in
// recordPropertyChanges instead.
const FIELD_NAMES: { [K in keyof ChangeSnapshot]: string } = {
  priceDisplay: "price_display",
  priceNumeric: "price_numeric",
  nextInspection: "next_inspection",
  beds: "beds",
  baths: "baths",
  parking: "parking",
  landSizeSqm: "land_size_sqm",
  propertyType: "property_type",
  address: "address",
  agentName: "agent_name",
  agencyName: "agency_name",
  saleStatus: "sale_status",
  photos: "photos",
};

/**
 * Snapshot of the tracked fields for a property RIGHT NOW, or null if the
 * property doesn't exist. Callers snapshot with the id they're ABOUT to write
 * to *before* writing — for a brand-new row that id doesn't exist yet, so this
 * correctly returns null, which is what tells recordPropertyChanges the write
 * is a first appearance rather than an update.
 */
export function snapshotProperty(propertyId: string): ChangeSnapshot | null {
  const row = db
    .select({
      listingUrl: properties.listingUrl,
      altListingUrl: properties.altListingUrl,
      priceDisplay: properties.priceDisplay,
      priceNumeric: properties.priceNumeric,
      nextInspection: properties.nextInspection,
      beds: properties.beds,
      baths: properties.baths,
      parking: properties.parking,
      landSizeSqm: properties.landSizeSqm,
      propertyType: properties.propertyType,
      address: properties.address,
      agentName: properties.agentName,
      agencyName: properties.agencyName,
    })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .get();
  if (!row) return null;

  const photosRow = db
    .select({ c: sql<number>`count(*)` })
    .from(images)
    .where(eq(images.propertyId, propertyId))
    .get();

  const { listingUrl, altListingUrl, ...tracked } = row;
  const saleStatus = getSaleStatus({ listingUrl, altListingUrl });
  return { ...tracked, saleStatus, photos: photosRow?.c ?? 0 };
}

/** null, undefined and "key not sent" all collapse to the same absent value; 1 and "1" compare equal. */
function normalize(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * Diffs a fresh snapshot against `before` and appends one property_changes row
 * per differing tracked field. Append-only — this never updates or deletes an
 * existing row.
 *
 * `before === null` means the property did not exist prior to this write — a
 * listing appearing is treated as its first change, recorded as exactly one
 * synthetic `listing: null -> "new"` row rather than one row per field (which
 * would just be noise on every brand-new property). This is a deliberate
 * reading of "all the changes to all properties", not scope creep.
 *
 * Never throws into the write path it's called beside: a logging failure here
 * (a locked DB, a corrupt row) must not lose the property upsert it sits next
 * to. Reported via console.warn rather than swallowed silently.
 */
export function recordPropertyChanges(propertyId: string, before: ChangeSnapshot | null): number {
  try {
    const after = snapshotProperty(propertyId);
    if (!after) return 0; // the write this is logging didn't actually land — nothing to record

    const now = new Date().toISOString();
    const insert = (field: string, b: string | null, a: string | null) =>
      db
        .insert(propertyChanges)
        .values({ id: randomUUID(), propertyId, field, before: b, after: a, createdAt: now })
        .run();

    if (before === null) {
      insert("listing", null, "new");
      return 1;
    }

    let n = 0;
    for (const key of Object.keys(FIELD_NAMES) as (keyof ChangeSnapshot)[]) {
      const b = normalize(before[key]);
      const a = normalize(after[key]);
      if (b === a) continue;
      insert(FIELD_NAMES[key], b, a);
      n++;
    }
    return n;
  } catch (e) {
    console.warn(`recordPropertyChanges(${propertyId}) failed:`, e instanceof Error ? e.message : e);
    return 0;
  }
}

/**
 * property_changes rows for a watchlisted property, newer than `since` (the
 * watchlist-bell watermark) — backs GET /api/changes/unread. An absent
 * watermark means "everything is unseen", modelled by the caller passing ""
 * (every ISO created_at sorts after it). Same shape as unreadShareCount
 * (queries/shares.ts) — a two-table join belongs in a query module, not the
 * route handler.
 */
export function unreadWatchlistChangeCount(since: string | null): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(propertyChanges)
    .innerJoin(properties, eq(properties.id, propertyChanges.propertyId))
    .where(and(eq(properties.watchlisted, 1), gt(propertyChanges.createdAt, since ?? "")))
    .get();
  return row?.c ?? 0;
}
