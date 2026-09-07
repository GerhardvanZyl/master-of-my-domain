import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";
import { newId } from "@/lib/id";
import { snapshotProperty, recordPropertyChanges } from "@/db/queries/changes";
import { isDelisted } from "@/db/queries/properties";
import type { NormalizedProperty } from "./types";

/**
 * Street address, comparable across sites: lowercase, unit separators unified
 * ("4/275" stays distinct from "275"), punctuation and suburb/state/postcode
 * tail dropped so "5 Foo St, Point Cook VIC 3030" == "5 Foo Street".
 *
 * Postcode is deliberately NOT part of the key: it carries no information the
 * suburb doesn't already carry (an AU suburb has one postcode), but a listing
 * captured without one used to get key "…|point cook|" which could never equal
 * the stored "…|point cook|3030" — so the twin never matched and the same house
 * got a second row with none of its ratings, notes or deduced metadata.
 */
export function addressKey(p: {
  address?: string | null;
  suburb?: string | null;
}): string | null {
  if (!p.address) return null;
  const street = p.address.split(",")[0];
  const key = street
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\broad\b/g, "rd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bcrescent\b/g, "cres")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bcircuit\b/g, "cct")
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
  if (!key) return null;
  return `${key}|${(p.suburb ?? "").toLowerCase().trim()}`;
}

export { addressKey as __addressKeyForTest };

/**
 * The existing property for a house, matched on address rather than URL — the
 * same twin lookup upsertProperty does, shared so the bulk loader (queries/load.ts)
 * can't drift away from ingest and start minting the duplicates ingest avoids.
 * Returns null when the input has no usable address or nothing matches.
 */
export function findTwinByAddress(p: {
  address?: string | null;
  suburb?: string | null;
}): string | null {
  const key = addressKey(p);
  if (!key) return null;
  // ponytail: compare the key against every row rather than pre-filtering in
  // SQL. Ingest and bulk loads happen a few times a day over ~300 rows, and a
  // narrowing predicate that disagrees with the key is exactly how the postcode
  // bug hid. Add an index only if this ever shows up in a trace.
  const twin = db
    .select({
      id: properties.id,
      address: properties.address,
      suburb: properties.suburb,
    })
    .from(properties)
    .all()
    .find((r) => addressKey(r) === key);
  return twin?.id ?? null;
}

// When we last looked at a listing and how that went is not property data, so a
// twin merge always writes it — which also keeps its UPDATE non-empty.
const MERGE_BOOKKEEPING = new Set(["scrapedAt", "updatedAt", "scrapeStatus", "scrapeError"]);

/** How a twin match must be written, and whether the caller logs it. */
export interface TwinMerge {
  set: Record<string, unknown>;
  log: boolean;
}

/**
 * Decides how a twin match writes onto the canonical row. Two matches reach
 * here and they are opposites:
 *
 * CROSS-source (the other site, same live listing) fills GAPS only, and logs
 * nothing. Overwriting cannot converge: the secondary source rewrites a shared
 * field in its own wording every sync, the canonical listing then loads by URL,
 * finds a value it did not write and records a change back to its own wording —
 * one phantom property_changes row per property per round, forever. Accepted
 * cost: a change visible ONLY through the secondary listing is not applied; the
 * canonical listing loads in the same round through the by-URL branch.
 *
 * SAME-source (a relisting under a new URL) OVERWRITES, and logs. Gap-filling
 * one freezes the row at the withdrawn listing's price, inspection and agent
 * forever — the old URL never returns in the feed, so nothing else can correct
 * it, while scraped_at keeps refreshing and the row reads as current. Accepted
 * cost: two SIMULTANEOUSLY live listings on one site for one house resume
 * oscillating. That is rarer than a relisting, and it does not silently show a
 * stale price.
 *
 * Cross-source stops gap-filling once the canonical listing is delisted: it is
 * no longer loaded by URL, so there is nothing left to flip a value back, and
 * freezing would keep stale data the surviving listing could correct.
 *
 * The canonical listing_url and source_site are never written by either.
 */
export function twinMerge(
  canonicalId: string,
  incoming: { listingUrl: string; sourceSite?: string | null },
  set: Record<string, unknown>,
): TwinMerge {
  const current = db.select().from(properties).where(eq(properties.id, canonicalId)).get();
  if (!current) return { set, log: true };
  if (incoming.sourceSite == null || incoming.sourceSite === current.sourceSite) {
    return { set, log: true };
  }

  // How the app learns the house may still be live on the other site even once
  // this listing goes (getSaleStatus, db/queries/properties.ts). Written on
  // every cross-source merge, not gap-filled, so it follows the twin when the
  // other site relists — a frozen alt URL nothing marks would read as live
  // forever. ponytail: one alt per row; two sources is the ceiling.
  const alt = current.listingUrl === incoming.listingUrl ? {} : { altListingUrl: incoming.listingUrl };
  if (isDelisted(current)) return { set: { ...set, ...alt }, log: true };

  const cols = current as unknown as Record<string, unknown>;
  const gaps = Object.entries(set).filter(([k]) => MERGE_BOOKKEEPING.has(k) || cols[k] == null);
  return { set: { ...Object.fromEntries(gaps), ...alt }, log: false };
}

/**
 * Upsert a property keyed by listing_url. Returns the property id.
 * On re-scrape the existing row is updated in place (id + created_at preserved),
 * so linked images/tags survive.
 *
 * A listing captured from the OTHER site (realestate.com.au vs Domain) has a
 * different URL but is the same house — it's matched on address so its photos
 * attach to the existing row instead of creating a twin that has none of the
 * shortlist's ratings, notes or deduced metadata. The original row keeps its
 * listing_url and source_site; only fields the newcomer actually has are copied.
 */
export function upsertProperty(
  p: NormalizedProperty,
  opts: { status?: "ok" | "partial" | "error"; error?: string | null } = {},
): string {
  const now = new Date().toISOString();
  const existing = db
    .select({ id: properties.id, createdAt: properties.createdAt })
    .from(properties)
    .where(eq(properties.listingUrl, p.listingUrl))
    .get();

  const status = opts.status ?? p.status ?? "ok";
  const row = {
    sourceSite: p.sourceSite,
    listingUrl: p.listingUrl,
    externalId: p.externalId ?? null,
    address: p.address ?? null,
    suburb: p.suburb ?? null,
    state: p.state ?? null,
    postcode: p.postcode ?? null,
    priceDisplay: p.priceDisplay ?? null,
    priceNumeric: p.priceNumeric ?? null,
    beds: p.beds ?? null,
    baths: p.baths ?? null,
    parking: p.parking ?? null,
    landSizeSqm: p.landSizeSqm ?? null,
    propertyType: p.propertyType ?? null,
    agentName: p.agentName ?? null,
    agencyName: p.agencyName ?? null,
    description: p.description ?? null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    nextInspection: p.nextInspection ?? null,
    rawJson: p.raw ? JSON.stringify(p.raw) : null,
    scrapedAt: now,
    updatedAt: now,
    scrapeStatus: status,
    scrapeError: opts.error ?? null,
  };

  if (existing) {
    const before = snapshotProperty(existing.id);
    db.update(properties).set(row).where(eq(properties.id, existing.id)).run();
    recordPropertyChanges(existing.id, before);
    return existing.id;
  }

  // Same house from the other site? Attach to it rather than making a twin.
  const twinId = findTwinByAddress(p);
  if (twinId) {
    // `v != null` is "the newcomer has a value"; twinMerge decides whether it
    // may overwrite one the canonical row already has, and whether the write is
    // news worth logging. Identity columns are never merged at all.
    const merged = Object.fromEntries(
      Object.entries(row).filter(
        ([k, v]) =>
          v != null && k !== "listingUrl" && k !== "sourceSite" && k !== "externalId",
      ),
    );
    const before = snapshotProperty(twinId);
    const merge = twinMerge(twinId, p, merged);
    db.update(properties).set(merge.set).where(eq(properties.id, twinId)).run();
    if (merge.log) recordPropertyChanges(twinId, before);
    return twinId;
  }
  const id = newId("prop");
  db.insert(properties)
    .values({ id, createdAt: now, ...row })
    .run();
  // A fresh id can't exist yet, so its "before" is statically null -- no need
  // to spend a snapshotProperty() read confirming what we already know.
  recordPropertyChanges(id, null);
  return id;
}
