import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";
import { newId } from "@/lib/id";
import type { NormalizedProperty } from "./types";

/**
 * Street address, comparable across sites: lowercase, unit separators unified
 * ("4/275" stays distinct from "275"), punctuation and suburb/state/postcode
 * tail dropped so "5 Foo St, Point Cook VIC 3030" == "5 Foo Street".
 */
function addressKey(p: {
  address?: string | null;
  suburb?: string | null;
  postcode?: string | null;
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
  return `${key}|${(p.suburb ?? "").toLowerCase().trim()}|${p.postcode ?? ""}`;
}

export { addressKey as __addressKeyForTest };

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

  // Same house from the other site? Attach to it rather than making a twin.
  const key = addressKey(p);
  if (key) {
    const twin = db
      .select({
        id: properties.id,
        address: properties.address,
        suburb: properties.suburb,
        postcode: properties.postcode,
      })
      .from(properties)
      .where(eq(properties.postcode, p.postcode ?? ""))
      .all()
      .find((r) => addressKey(r) === key);
    if (twin) {
      // Only overwrite with values the newcomer actually has; never clobber the
      // canonical listing_url / source_site.
      const merged = Object.fromEntries(
        Object.entries(row).filter(
          ([k, v]) =>
            v != null && k !== "listingUrl" && k !== "sourceSite" && k !== "externalId",
        ),
      );
      db.update(properties).set(merged).where(eq(properties.id, twin.id)).run();
      return twin.id;
    }
  }
  const id = newId("prop");
  db.insert(properties)
    .values({ id, createdAt: now, ...row })
    .run();
  return id;
}
