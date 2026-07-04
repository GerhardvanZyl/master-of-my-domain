import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";
import { newId } from "@/lib/id";
import type { NormalizedProperty } from "./types";

/**
 * Upsert a property keyed by listing_url. Returns the property id.
 * On re-scrape the existing row is updated in place (id + created_at preserved),
 * so linked images/tags survive.
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
    rawJson: p.raw ? JSON.stringify(p.raw) : null,
    scrapedAt: now,
    updatedAt: now,
    scrapeStatus: status,
    scrapeError: opts.error ?? null,
  };

  if (existing) {
    db.update(properties).set(row).where(eq(properties.id, existing.id)).run();
    return existing.id;
  }
  const id = newId("prop");
  db.insert(properties)
    .values({ id, createdAt: now, ...row })
    .run();
  return id;
}
