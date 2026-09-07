import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../client";
import { properties, priceHistory } from "../schema";
import { findTwinByAddress, twinMerge } from "@/scrape/persist";
import { sanitizePropertyComAuUrl, sanitizeYearBuilt } from "@/lib/property-com-au";
import { snapshotProperty, recordPropertyChanges } from "./changes";

/**
 * Shape accepted by the bulk loader — `npm run load`, the harvest scripts, and
 * the `properties` section of POST /api/batch (which exists so an update run can
 * write to the app on another host without shipping the SQLite file). Only
 * listingUrl is required; everything else is optional enrichment gathered
 * while browsing. Upserts by listing_url. price_history is append-only — a load
 * can only ADD new observations, never delete or overwrite existing rows.
 * Idempotent — re-running overwrites core fields in place, adds no dup history.
 */
export interface LoadItem {
  listingUrl: string;
  sourceSite?: string;
  externalId?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  priceDisplay?: string;
  priceNumeric?: number | null;
  beds?: number | null;
  baths?: number | null;
  parking?: number | null;
  landSizeSqm?: number | null;
  propertyType?: string;
  agentName?: string;
  agencyName?: string;
  description?: string;
  latitude?: number | null;
  longitude?: number | null;
  nearestStation?: string;
  stationDistanceM?: number | null;
  secondStation?: string;
  secondStationDistanceM?: number | null;
  ptMinutesToFlinders?: number | null;
  ptRouteSummary?: string;
  ptSteps?: string | null;
  advPriceCurrent?: string | null;
  advPricePrevious?: string | null;
  advPricePreviousLabel?: string | null;
  nextInspection?: string | null;
  greenCrossDistanceM?: number | null;
  colesDistanceM?: number | null;
  colesName?: string | null;
  playgrounds500m?: number | null;
  domainNotes?: string | null;
  aiComment?: string | null;
  hasEaves?: number | null;
  altitudeM?: number | null;
  floodOverlay?: number | null;
  bushfireOverlay?: number | null;
  masterBedSqm?: number | null;
  avgOtherBedSqm?: number | null;
  commonAreasCount?: number | null;
  balconySqm?: number | null;
  backGardenSqm?: number | null;
  pergolaCovered?: number | null;
  hasLawn?: number | null;
  lawnType?: string | null;
  // Untrusted, externally sourced — validated in loadProperties before it ever
  // reaches a column (see lib/property-com-au.ts). No backfill in this change;
  // both are null for every existing row until a future sync round populates
  // them.
  propertyComAuUrl?: string | null;
  // number is the "clean" shape; string covers the real extraction path (a
  // regex capture group — see lib/property-com-au.ts), which sanitizeYearBuilt
  // now accepts directly rather than silently rejecting.
  yearBuilt?: number | string | null;
  priceHistory?: {
    date?: string;
    event?: string;
    priceDisplay?: string;
    priceNumeric?: number | null;
  }[];
}

export function loadProperties(items: LoadItem[]) {
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  let priceRows = 0;
  // Counts a sanitize* rejection (malformed input, not "field not sent"), so a
  // sync round that sent the wrong shape shows up as something other than a
  // clean `ok:true` — see lib/property-com-au.ts's tri-state contract. No
  // per-item try/catch and no change to the no-throw guarantee: this only
  // counts, it never stops the loop or discards a row.
  let rejected = 0;

  for (const it of items) {
    if (!it.listingUrl) continue;
    const byUrl = db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.listingUrl, it.listingUrl))
      .get();
    // Same house harvested under a different URL (the other site, or a relisting)
    // attaches to the existing row, exactly as ingest does — otherwise a load
    // mints the duplicate that upsertProperty exists to prevent, and your
    // ratings/notes/metadata stay on the row you can no longer see.
    const twinId = byUrl ? null : findTwinByAddress(it);
    const existing = byUrl ?? (twinId ? { id: twinId } : undefined);
    const id = existing?.id ?? randomUUID();
    const before = snapshotProperty(id);

    // Only touch columns the item actually carries, so a partial load (e.g.
    // price-history-only) doesn't null out core fields on an existing row.
    const cols: Record<string, unknown> = {
      externalId: it.externalId,
      address: it.address,
      suburb: it.suburb,
      state: it.state,
      postcode: it.postcode,
      priceDisplay: it.priceDisplay,
      priceNumeric: it.priceNumeric,
      beds: it.beds,
      baths: it.baths,
      parking: it.parking,
      landSizeSqm: it.landSizeSqm,
      propertyType: it.propertyType,
      agentName: it.agentName,
      agencyName: it.agencyName,
      description: it.description,
      latitude: it.latitude,
      longitude: it.longitude,
      nearestStation: it.nearestStation,
      stationDistanceM: it.stationDistanceM,
      secondStation: it.secondStation,
      secondStationDistanceM: it.secondStationDistanceM,
      ptMinutesToFlinders: it.ptMinutesToFlinders,
      ptRouteSummary: it.ptRouteSummary,
      ptSteps: it.ptSteps,
      advPriceCurrent: it.advPriceCurrent,
      advPricePrevious: it.advPricePrevious,
      advPricePreviousLabel: it.advPricePreviousLabel,
      nextInspection: it.nextInspection,
      greenCrossDistanceM: it.greenCrossDistanceM,
      colesDistanceM: it.colesDistanceM,
      colesName: it.colesName,
      playgrounds500m: it.playgrounds500m,
      domainNotes: it.domainNotes,
      aiComment: it.aiComment,
      hasEaves: it.hasEaves,
      altitudeM: it.altitudeM,
      floodOverlay: it.floodOverlay,
      bushfireOverlay: it.bushfireOverlay,
      masterBedSqm: it.masterBedSqm,
      avgOtherBedSqm: it.avgOtherBedSqm,
      commonAreasCount: it.commonAreasCount,
      balconySqm: it.balconySqm,
      backGardenSqm: it.backGardenSqm,
      pergolaCovered: it.pergolaCovered,
      hasLawn: it.hasLawn,
      lawnType: it.lawnType,
      // Malformed input resolves to `undefined` here (see sanitize* docs),
      // which the loop below treats as "not sent" — a bad row can't null out
      // a previously-good value on a partial update.
      propertyComAuUrl: sanitizePropertyComAuUrl(it.propertyComAuUrl),
      yearBuilt: sanitizeYearBuilt(it.yearBuilt),
    };
    // A rejection is distinguished from "not sent" by the item actually
    // carrying the key (it.field !== undefined) while the sanitizer still
    // came back undefined — that's a value the caller sent that got thrown
    // away, not one it never sent at all.
    if (it.propertyComAuUrl !== undefined && cols.propertyComAuUrl === undefined) rejected++;
    if (it.yearBuilt !== undefined && cols.yearBuilt === undefined) rejected++;
    const set: Record<string, unknown> = { scrapedAt: now, updatedAt: now };
    for (const [k, v] of Object.entries(cols)) if (v !== undefined) set[k] = v;
    // On an address merge the stored row keeps its canonical listing_url (never
    // in `set`) and source_site — same rule upsertProperty applies.
    if (it.sourceSite !== undefined && !twinId) set.sourceSite = it.sourceSite;
    // Refresh rawJson only on a full core load (address present), not on a
    // price-history-only load which would otherwise clobber the raw snapshot.
    if (it.address !== undefined) set.rawJson = JSON.stringify(it);

    // A CROSS-source twin match fills gaps only and reports nothing; a
    // same-source one is a relisting and overwrites -- see twinMerge
    // (scrape/persist.ts), which owns both rules and the reasons for them.
    const merge = twinId ? twinMerge(twinId, it, set) : null;
    if (existing) {
      db.update(properties)
        .set(merge ? merge.set : set)
        .where(eq(properties.id, id))
        .run();
      updated++;
    } else {
      db.insert(properties)
        .values({
          id,
          listingUrl: it.listingUrl,
          sourceSite: it.sourceSite ?? "domain",
          createdAt: now,
          scrapedAt: now,
          updatedAt: now,
          ...set,
        })
        .run();
      inserted++;
    }
    if (!merge || merge.log) recordPropertyChanges(id, before);

    // Append-only: never delete existing price rows. Insert only observations
    // not already recorded (dedup on date+event+display), so loads can only ever
    // ADD to a property's price history, never overwrite or wipe it.
    if (it.priceHistory) {
      const seen = new Set(
        db
          .select({
            date: priceHistory.date,
            event: priceHistory.event,
            priceDisplay: priceHistory.priceDisplay,
          })
          .from(priceHistory)
          .where(eq(priceHistory.propertyId, id))
          .all()
          .map((r) => `${r.date} ${r.event} ${r.priceDisplay}`),
      );
      for (const p of it.priceHistory) {
        const key = `${p.date ?? null} ${p.event ?? null} ${p.priceDisplay ?? null}`;
        if (seen.has(key)) continue;
        seen.add(key);
        db.insert(priceHistory)
          .values({
            id: randomUUID(),
            propertyId: id,
            date: p.date ?? null,
            event: p.event ?? null,
            priceDisplay: p.priceDisplay ?? null,
            priceNumeric: p.priceNumeric ?? null,
            createdAt: now,
          })
          .run();
        priceRows++;
      }
    }
  }
  return { inserted, updated, rejected, priceRows, total: items.length };
}
