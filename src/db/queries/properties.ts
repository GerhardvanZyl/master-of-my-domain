import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { properties, images, imageTags } from "../schema";
import type { Property } from "../schema";

export interface PropertyListItem extends Property {
  imageCount: number;
  thumbPath: string | null;
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

  return props.map((p) => ({
    ...p,
    imageCount: counts.get(p.id) ?? 0,
    thumbPath: thumb.get(p.id) ?? null,
  }));
}

export function getProperty(id: string): Property | undefined {
  return db.select().from(properties).where(eq(properties.id, id)).get();
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
    })
    .from(images)
    .leftJoin(imageTags, eq(imageTags.imageId, images.id))
    .where(eq(images.propertyId, propertyId))
    .orderBy(images.ordinal)
    .all();
}

export function deleteProperty(id: string): void {
  db.delete(properties).where(eq(properties.id, id)).run();
}
