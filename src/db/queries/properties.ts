import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { properties, images, imageTags, scrapeJobs, priceHistory, propertyRatings } from "../schema";
import type { Property, PriceHistory, PropertyRating } from "../schema";
import { IMAGES_DIR } from "@/lib/env";
import { priorityScore } from "@/lib/priority";

export interface PropertyListItem extends Property {
  imageCount: number;
  thumbPath: string | null;
  /** Listing no longer appears in Domain search results (sold/withdrawn). */
  delisted: boolean;
  ratings: Pick<PropertyRating, "profile" | "vibe" | "look" | "kitchen" | "score">[];
}

function aspect(width: number | null, height: number | null): number | null {
  return width && height ? width / height : null;
}

/**
 * A real listing photo. Domain standardises facade/interior shots to 3:2
 * (aspect 1.50), while floorplans (portrait or A-paper 1.41), agent logos
 * (square 1.00) and banner strips (2.9–14) are anything but 3:2 — so match
 * near 3:2 rather than just "landscape", which let landscape floorplans through.
 */
export function isHeroPhoto(width: number | null, height: number | null): boolean {
  const a = aspect(width, height);
  return a != null && Math.abs(a - 1.5) < 0.06;
}

function isLandscape(width: number | null, height: number | null): boolean {
  const a = aspect(width, height);
  return a != null && a >= 1;
}

/**
 * Domain's designated cover/hero photo. Domain emits the listing's chosen cover
 * as a distinct "_3" crop variant (e.g. `2020830624_28_3_260511-…`); every other
 * photo is `_1`. So a source URL matching `_<n>_3_<date>` IS the image Domain
 * leads with. (Listings captured via the older extension path have no `_3`
 * variant — those fall back to the aspect heuristic.)
 */
export function isDomainCover(sourceUrl?: string | null): boolean {
  return !!sourceUrl && /_\d+_3_\d/.test(sourceUrl);
}

/**
 * The floorplan image, if the listing has one. Floorplans are portrait (< 0.92)
 * or A-paper landscape (~1.41) — never Domain's 3:2 photos or square logos. An
 * explicit notes='floorplan' tag wins over the heuristic.
 */
export function pickFloorplan<
  T extends { width: number | null; height: number | null; notes?: string | null },
>(imgs: T[]): T | null {
  const isFloorplan = (w: number | null, h: number | null) => {
    const a = aspect(w, h);
    return a != null && (a < 0.92 || (a > 1.37 && a < 1.46));
  };
  return (
    imgs.find((i) => i.notes === "floorplan") ??
    imgs.find((i) => isFloorplan(i.width, i.height)) ??
    null
  );
}

/**
 * Hero image: an explicit pick (notes='hero') wins; else Domain's own cover
 * (the `_3` crop) so we lead with the exact photo Domain does; else first 3:2
 * photo, else first landscape, else the first image.
 */
export function pickHero<
  T extends {
    width: number | null;
    height: number | null;
    notes?: string | null;
    sourceUrl?: string | null;
  },
>(imgs: T[]): T | null {
  return (
    imgs.find((i) => i.notes === "hero") ??
    imgs.find((i) => isDomainCover(i.sourceUrl)) ??
    imgs.find((i) => isHeroPhoto(i.width, i.height)) ??
    imgs.find((i) => isLandscape(i.width, i.height)) ??
    imgs[0] ??
    null
  );
}

/**
 * The n photos that best show off the property, shown as a strip under the hero.
 * Heuristic: Domain's clean 3:2 shots (facade/interior/exterior), skipping the
 * hero and the floorplan; tops up with any remaining photos if there aren't n.
 * ponytail: no room tags on most listings, so "best" = Domain's standard-crop
 * photos in listing order. Tag images notes='hero' / add a curated pick later.
 */
export function pickShowcase<
  T extends {
    width: number | null;
    height: number | null;
    notes?: string | null;
    sourceUrl?: string | null;
  },
>(imgs: T[], hero: T | null, n: number): T[] {
  const floor = pickFloorplan(imgs);
  const skip = new Set<T>([hero, floor].filter(Boolean) as T[]);
  const out = imgs.filter((i) => !skip.has(i) && isHeroPhoto(i.width, i.height));
  if (out.length < n) {
    for (const i of imgs) {
      if (skip.has(i) || out.includes(i)) continue;
      out.push(i);
      if (out.length >= n) break;
    }
  }
  return out.slice(0, n);
}

export function listProperties(): PropertyListItem[] {
  const props = db
    .select()
    .from(properties)
    .orderBy(desc(properties.createdAt))
    .all();

  const imgs = db
    .select({
      propertyId: images.propertyId,
      localPath: images.localPath,
      sourceUrl: images.sourceUrl,
      ordinal: images.ordinal,
      width: images.width,
      height: images.height,
      notes: imageTags.notes,
    })
    .from(images)
    .leftJoin(imageTags, eq(imageTags.imageId, images.id))
    .orderBy(images.ordinal)
    .all();

  const counts = new Map<string, number>();
  const thumbHero = new Map<string, string>(); // explicit notes='hero' pick wins
  const thumbCover = new Map<string, string>(); // Domain's own cover (_3 crop)
  const thumb = new Map<string, string>(); // first 3:2 photo — never a floorplan/logo
  const thumbLand = new Map<string, string>(); // fallback: first landscape
  const thumbAny = new Map<string, string>(); // last resort
  for (const i of imgs) {
    counts.set(i.propertyId, (counts.get(i.propertyId) ?? 0) + 1);
    if (!thumbAny.has(i.propertyId)) thumbAny.set(i.propertyId, i.localPath);
    if (i.notes === "hero") thumbHero.set(i.propertyId, i.localPath);
    if (!thumbCover.has(i.propertyId) && isDomainCover(i.sourceUrl))
      thumbCover.set(i.propertyId, i.localPath);
    if (!thumbLand.has(i.propertyId) && isLandscape(i.width, i.height))
      thumbLand.set(i.propertyId, i.localPath);
    if (!thumb.has(i.propertyId) && isHeroPhoto(i.width, i.height))
      thumb.set(i.propertyId, i.localPath);
  }

  const ratingRows = db
    .select({
      propertyId: propertyRatings.propertyId,
      profile: propertyRatings.profile,
      vibe: propertyRatings.vibe,
      look: propertyRatings.look,
      kitchen: propertyRatings.kitchen,
      score: propertyRatings.score,
    })
    .from(propertyRatings)
    .all();
  const ratingsByProp = new Map<string, PropertyListItem["ratings"]>();
  for (const r of ratingRows) {
    const arr = ratingsByProp.get(r.propertyId) ?? [];
    arr.push({
      profile: r.profile,
      vibe: r.vibe,
      look: r.look,
      kitchen: r.kitchen,
      score: r.score,
    });
    ratingsByProp.set(r.propertyId, arr);
  }

  // Listings flagged as no longer in search results (sold/withdrawn) — tracked in
  // scrape_jobs rather than deleting the row, so ratings/notes survive.
  const delistedUrls = new Set(
    db
      .select({ url: scrapeJobs.url })
      .from(scrapeJobs)
      .where(eq(scrapeJobs.status, "delisted"))
      .all()
      .map((r) => r.url),
  );

  return props
    .map((p) => ({
      ...p,
      imageCount: counts.get(p.id) ?? 0,
      thumbPath:
        thumbHero.get(p.id) ??
        thumbCover.get(p.id) ??
        thumb.get(p.id) ??
        thumbLand.get(p.id) ??
        thumbAny.get(p.id) ??
        null,
      delisted: delistedUrls.has(p.listingUrl),
      ratings: ratingsByProp.get(p.id) ?? [],
    }))
    // Priority order: nearest the $850k target first, more bedrooms boosts.
    .sort(
      (a, b) =>
        priorityScore(b.beds, b.priceNumeric) -
        priorityScore(a.beds, a.priceNumeric),
    );
}

export function getProperty(id: string): Property | undefined {
  return db.select().from(properties).where(eq(properties.id, id)).get();
}

/** True if this listing URL has been flagged sold/withdrawn (scrape_jobs). */
export function isDelisted(listingUrl: string): boolean {
  return !!db
    .select({ id: scrapeJobs.id })
    .from(scrapeJobs)
    .where(and(eq(scrapeJobs.url, listingUrl), eq(scrapeJobs.status, "delisted")))
    .get();
}

export function getPriceHistory(propertyId: string): PriceHistory[] {
  return db
    .select()
    .from(priceHistory)
    .where(eq(priceHistory.propertyId, propertyId))
    .orderBy(priceHistory.date)
    .all()
    // Task 19: rental history isn't relevant to a purchase — show sales only.
    .filter((h) => !/rent|lease/i.test(h.event ?? ""));
}

export function getPropertiesByIds(ids: string[]): Property[] {
  if (ids.length === 0) return [];
  const rows = db
    .select()
    .from(properties)
    .where(inArray(properties.id, ids))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((p): p is Property => !!p);
}

/** Rating rows (both profiles) for one property — used by the detail rail. */
export function getPropertyRatings(propertyId: string): PropertyListItem["ratings"] {
  return db
    .select({
      profile: propertyRatings.profile,
      vibe: propertyRatings.vibe,
      look: propertyRatings.look,
      kitchen: propertyRatings.kitchen,
      score: propertyRatings.score,
    })
    .from(propertyRatings)
    .where(eq(propertyRatings.propertyId, propertyId))
    .all();
}

/** Same, keyed by property id, for a set of properties (compare view). */
export function getRatingsByProperty(
  ids: string[],
): Map<string, PropertyListItem["ratings"]> {
  const out = new Map<string, PropertyListItem["ratings"]>();
  if (ids.length === 0) return out;
  const rows = db
    .select()
    .from(propertyRatings)
    .where(inArray(propertyRatings.propertyId, ids))
    .all();
  for (const r of rows) {
    const arr = out.get(r.propertyId) ?? [];
    arr.push({ profile: r.profile, vibe: r.vibe, look: r.look, kitchen: r.kitchen, score: r.score });
    out.set(r.propertyId, arr);
  }
  return out;
}

export interface ImageWithTag {
  id: string;
  propertyId: string;
  sourceUrl: string;
  localPath: string;
  ordinal: number;
  width: number | null;
  height: number | null;
  roomType: string | null;
  notes: string | null;
}

export function getPropertyImages(propertyId: string): ImageWithTag[] {
  return db
    .select({
      id: images.id,
      propertyId: images.propertyId,
      sourceUrl: images.sourceUrl,
      localPath: images.localPath,
      ordinal: images.ordinal,
      width: images.width,
      height: images.height,
      roomType: imageTags.roomType,
      notes: imageTags.notes,
    })
    .from(images)
    .leftJoin(imageTags, eq(imageTags.imageId, images.id))
    .where(eq(images.propertyId, propertyId))
    .orderBy(images.ordinal)
    .all();
}

export function deleteProperty(id: string): void {
  // Detach history rows first: scrape_jobs.property_id has no ON DELETE action,
  // so with foreign_keys=ON the delete would otherwise fail.
  db.update(scrapeJobs)
    .set({ propertyId: null })
    .where(eq(scrapeJobs.propertyId, id))
    .run();
  db.delete(properties).where(eq(properties.id, id)).run();
  // id comes from a request param — keep the rm strictly inside IMAGES_DIR.
  const dir = path.resolve(IMAGES_DIR, id);
  if (dir.startsWith(path.resolve(IMAGES_DIR) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
