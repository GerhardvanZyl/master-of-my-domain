import fs from "node:fs";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { properties, images, imageTags, scrapeJobs, priceHistory, propertyRatings } from "../schema";
import type { Property, PriceHistory, PropertyRating } from "../schema";
import { IMAGES_DIR } from "@/lib/env";
import { priorityScore } from "@/lib/priority";

export interface PropertyListItem extends Property {
  imageCount: number;
  thumbPath: string | null;
  ratings: Pick<PropertyRating, "profile" | "vibe" | "look" | "kitchen">[];
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
      ordinal: images.ordinal,
    })
    .from(images)
    .orderBy(images.ordinal)
    .all();

  const counts = new Map<string, number>();
  const thumb = new Map<string, string>();
  for (const i of imgs) {
    counts.set(i.propertyId, (counts.get(i.propertyId) ?? 0) + 1);
    if (!thumb.has(i.propertyId)) thumb.set(i.propertyId, i.localPath);
  }

  const ratingRows = db
    .select({
      propertyId: propertyRatings.propertyId,
      profile: propertyRatings.profile,
      vibe: propertyRatings.vibe,
      look: propertyRatings.look,
      kitchen: propertyRatings.kitchen,
    })
    .from(propertyRatings)
    .all();
  const ratingsByProp = new Map<string, PropertyListItem["ratings"]>();
  for (const r of ratingRows) {
    const arr = ratingsByProp.get(r.propertyId) ?? [];
    arr.push({ profile: r.profile, vibe: r.vibe, look: r.look, kitchen: r.kitchen });
    ratingsByProp.set(r.propertyId, arr);
  }

  return props
    .map((p) => ({
      ...p,
      imageCount: counts.get(p.id) ?? 0,
      thumbPath: thumb.get(p.id) ?? null,
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

export function getPriceHistory(propertyId: string): PriceHistory[] {
  return db
    .select()
    .from(priceHistory)
    .where(eq(priceHistory.propertyId, propertyId))
    .orderBy(priceHistory.date)
    .all();
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
