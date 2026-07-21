import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../client";
import { properties, priceHistory } from "../schema";

/**
 * Shape accepted by the bulk loader (CLI script + /api/load-batch). Only
 * listingUrl is required; everything else is optional enrichment gathered
 * while browsing. Upserts by listing_url; a property's price_history is
 * replaced each load. Idempotent — re-running overwrites in place.
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

  for (const it of items) {
    if (!it.listingUrl) continue;
    const existing = db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.listingUrl, it.listingUrl))
      .get();
    const id = existing?.id ?? randomUUID();

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
    };
    const set: Record<string, unknown> = { scrapedAt: now, updatedAt: now };
    for (const [k, v] of Object.entries(cols)) if (v !== undefined) set[k] = v;
    if (it.sourceSite !== undefined) set.sourceSite = it.sourceSite;
    // Refresh rawJson only on a full core load (address present), not on a
    // price-history-only load which would otherwise clobber the raw snapshot.
    if (it.address !== undefined) set.rawJson = JSON.stringify(it);

    if (existing) {
      db.update(properties).set(set).where(eq(properties.id, id)).run();
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

    // Only replace price history when this load actually carries it, so a
    // core-only reload doesn't wipe history captured by an earlier deep pass.
    if (it.priceHistory) {
      db.delete(priceHistory).where(eq(priceHistory.propertyId, id)).run();
      for (const p of it.priceHistory) {
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
  return { inserted, updated, priceRows, total: items.length };
}
