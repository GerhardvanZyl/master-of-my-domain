import path from "node:path";
import { sqlite } from "../client";
import { DATA_DIR } from "@/lib/env";

// The photo-deduced metadata columns (task 5 eaves + task 10 room sizes).
// Flag name (kebab) -> DB column. All optional; a set only touches what's given.
export const META_COLUMNS: Record<string, string> = {
  "has-eaves": "has_eaves",
  "master-bed": "master_bed_sqm",
  "avg-other-bed": "avg_other_bed_sqm",
  "common-areas": "common_areas_count",
  balcony: "balcony_sqm",
  "back-garden": "back_garden_sqm",
  pergola: "pergola_covered",
  "has-lawn": "has_lawn",
  "lawn-type": "lawn_type",
};

/** UPDATE only the columns present in `values`. Values are pre-coerced. */
export function setPropertyMetadata(
  propertyId: string,
  values: Record<string, number | string | null>,
): void {
  const exists = sqlite
    .prepare("SELECT 1 FROM properties WHERE id = ?")
    .get(propertyId);
  if (!exists) throw new Error(`No property with id ${propertyId}`);
  const cols = Object.keys(values);
  if (cols.length === 0) return;
  const assigns = cols.map((c) => `${META_COLUMNS[c]} = ?`).join(", ");
  const args = cols.map((c) => values[c]);
  sqlite
    .prepare(
      `UPDATE properties SET ${assigns}, updated_at = ? WHERE id = ?`,
    )
    .run(...args, new Date().toISOString(), propertyId);
}

// camelCase field -> column, for the correctable editor API (task 10). Wider
// than META_COLUMNS: also allows editing altitude + flood/bushfire overlays.
export const EDITABLE_COLUMNS: Record<string, string> = {
  hasEaves: "has_eaves",
  masterBedSqm: "master_bed_sqm",
  avgOtherBedSqm: "avg_other_bed_sqm",
  commonAreasCount: "common_areas_count",
  balconySqm: "balcony_sqm",
  backGardenSqm: "back_garden_sqm",
  pergolaCovered: "pergola_covered",
  hasLawn: "has_lawn",
  lawnType: "lawn_type",
  floodOverlay: "flood_overlay",
  bushfireOverlay: "bushfire_overlay",
  altitudeM: "altitude_m",
};

/** UPDATE only whitelisted, pre-coerced columns (camelCase keys). */
export function updatePropertyMetadata(
  propertyId: string,
  values: Record<string, number | string | null>,
): void {
  const cols = Object.keys(values).filter((k) => k in EDITABLE_COLUMNS);
  if (cols.length === 0) return;
  const exists = sqlite
    .prepare("SELECT 1 FROM properties WHERE id = ?")
    .get(propertyId);
  if (!exists) throw new Error(`No property with id ${propertyId}`);
  const assigns = cols.map((c) => `${EDITABLE_COLUMNS[c]} = ?`).join(", ");
  const args = cols.map((c) => values[c]);
  sqlite
    .prepare(`UPDATE properties SET ${assigns}, updated_at = ? WHERE id = ?`)
    .run(...args, new Date().toISOString(), propertyId);
}

export interface MetaProperty {
  propertyId: string;
  address: string | null;
  current: Record<string, number | string | null>;
  images: {
    imageId: string;
    ordinal: number;
    roomType: string | null;
    absPath: string;
  }[];
}

/**
 * Properties that have photos, with each photo's absPath + room tag and the
 * current deduced-metadata state. By default only lists ones still missing the
 * eaves/room-size deduction (has_eaves IS NULL) — pass all=true for every one.
 */
export function listPropertiesForMetadata(opts: {
  propertyId?: string;
  limit?: number;
  all?: boolean;
} = {}): MetaProperty[] {
  const where: string[] = ["EXISTS (SELECT 1 FROM images i WHERE i.property_id = p.id)"];
  const args: unknown[] = [];
  if (opts.propertyId) {
    where.push("p.id = ?");
    args.push(opts.propertyId);
  } else if (!opts.all) {
    where.push("p.has_eaves IS NULL");
  }
  let sql = `SELECT p.id AS id, p.address AS address,
      p.has_eaves AS hasEaves, p.master_bed_sqm AS masterBedSqm,
      p.avg_other_bed_sqm AS avgOtherBedSqm, p.common_areas_count AS commonAreasCount,
      p.balcony_sqm AS balconySqm, p.back_garden_sqm AS backGardenSqm,
      p.pergola_covered AS pergolaCovered, p.has_lawn AS hasLawn, p.lawn_type AS lawnType
    FROM properties p
    WHERE ${where.join(" AND ")}
    ORDER BY p.created_at DESC`;
  if (opts.limit && opts.limit > 0) sql += ` LIMIT ${Math.floor(opts.limit)}`;
  const props = sqlite.prepare(sql).all(...args) as Record<string, string | number | null>[];

  const imgStmt = sqlite.prepare(
    `SELECT i.id AS imageId, i.ordinal AS ordinal, i.local_path AS localPath,
        t.room_type AS roomType
      FROM images i
      LEFT JOIN image_tags t ON t.image_id = i.id
      WHERE i.property_id = ?
      ORDER BY i.ordinal`,
  );

  return props.map((p) => {
    const imgs = imgStmt.all(p.id) as {
      imageId: string;
      ordinal: number;
      localPath: string;
      roomType: string | null;
    }[];
    return {
      propertyId: p.id as string,
      address: (p.address as string | null) ?? null,
      current: {
        hasEaves: p.hasEaves,
        masterBedSqm: p.masterBedSqm,
        avgOtherBedSqm: p.avgOtherBedSqm,
        commonAreasCount: p.commonAreasCount,
        balconySqm: p.balconySqm,
        backGardenSqm: p.backGardenSqm,
        pergolaCovered: p.pergolaCovered,
        hasLawn: p.hasLawn,
        lawnType: p.lawnType,
      },
      images: imgs.map((i) => ({
        imageId: i.imageId,
        ordinal: i.ordinal,
        roomType: i.roomType,
        absPath: path.resolve(DATA_DIR, i.localPath),
      })),
    };
  });
}
