import path from "node:path";
import { sqlite } from "../client";
import { DATA_DIR } from "@/lib/env";
import { ROOM_TYPES, type RoomType } from "../schema";

export function isRoomType(v: string): v is RoomType {
  return (ROOM_TYPES as readonly string[]).includes(v);
}

export interface UntaggedImage {
  imageId: string;
  propertyId: string;
  address: string | null;
  ordinal: number;
  localPath: string;
  absPath: string;
}

/** Images that have no room_type yet. absPath is absolute for Claude's Read tool. */
export function listUntaggedImages(opts: {
  propertyId?: string;
  limit?: number;
} = {}): UntaggedImage[] {
  const clauses = ["t.image_id IS NULL"];
  const args: unknown[] = [];
  if (opts.propertyId) {
    clauses.push("i.property_id = ?");
    args.push(opts.propertyId);
  }
  let sql = `SELECT i.id AS imageId, i.property_id AS propertyId,
      p.address AS address, i.ordinal AS ordinal, i.local_path AS localPath
    FROM images i
    JOIN properties p ON p.id = i.property_id
    LEFT JOIN image_tags t ON t.image_id = i.id
    WHERE ${clauses.join(" AND ")}
    ORDER BY i.property_id, i.ordinal`;
  if (opts.limit && opts.limit > 0) sql += ` LIMIT ${Math.floor(opts.limit)}`;

  const rows = sqlite.prepare(sql).all(...args) as Omit<
    UntaggedImage,
    "absPath"
  >[];
  return rows.map((r) => ({
    ...r,
    absPath: path.resolve(DATA_DIR, r.localPath),
  }));
}

export interface TaggedImage extends UntaggedImage {
  roomType: RoomType;
}

/**
 * Images that already have a room_type — the ground truth a local model gets
 * benchmarked against. Read-only.
 */
export function listTaggedImages(
  opts: { propertyIds?: string[]; limit?: number } = {},
): TaggedImage[] {
  const clauses = ["t.room_type IS NOT NULL"];
  const args: unknown[] = [];
  if (opts.propertyIds && opts.propertyIds.length > 0) {
    clauses.push(
      `i.property_id IN (${opts.propertyIds.map(() => "?").join(",")})`,
    );
    args.push(...opts.propertyIds);
  }
  let sql = `SELECT i.id AS imageId, i.property_id AS propertyId,
      p.address AS address, i.ordinal AS ordinal, i.local_path AS localPath,
      t.room_type AS roomType
    FROM images i
    JOIN properties p ON p.id = i.property_id
    JOIN image_tags t ON t.image_id = i.id
    WHERE ${clauses.join(" AND ")}
    ORDER BY i.property_id, i.ordinal`;
  if (opts.limit && opts.limit > 0) sql += ` LIMIT ${Math.floor(opts.limit)}`;

  const rows = sqlite.prepare(sql).all(...args) as Omit<
    TaggedImage,
    "absPath"
  >[];
  return rows.map((r) => ({
    ...r,
    absPath: path.resolve(DATA_DIR, r.localPath),
  }));
}

/** The n properties with the most tagged photos — the default benchmark sample. */
export function topTaggedProperties(n: number): string[] {
  const rows = sqlite
    .prepare(
      `SELECT i.property_id AS id, COUNT(*) AS c
       FROM images i JOIN image_tags t ON t.image_id = i.id
       WHERE t.room_type IS NOT NULL
       GROUP BY i.property_id
       ORDER BY c DESC, i.property_id
       LIMIT ?`,
    )
    .all(Math.floor(n)) as { id: string }[];
  return rows.map((r) => r.id);
}

export function setImageTag(input: {
  imageId: string;
  roomType: RoomType;
  confidence?: number | null;
  notes?: string | null;
  taggedBy?: string;
}): void {
  const exists = sqlite
    .prepare("SELECT 1 FROM images WHERE id = ?")
    .get(input.imageId);
  if (!exists) throw new Error(`No image with id ${input.imageId}`);
  sqlite
    .prepare(
      `INSERT INTO image_tags (image_id, room_type, confidence, tagged_by, tagged_at, notes)
       VALUES (@imageId, @roomType, @confidence, @taggedBy, @taggedAt, @notes)
       ON CONFLICT(image_id) DO UPDATE SET
         room_type = excluded.room_type,
         confidence = excluded.confidence,
         tagged_by = excluded.tagged_by,
         tagged_at = excluded.tagged_at,
         notes = excluded.notes`,
    )
    .run({
      imageId: input.imageId,
      roomType: input.roomType,
      confidence: input.confidence ?? null,
      taggedBy: input.taggedBy ?? "claude-code",
      taggedAt: new Date().toISOString(),
      notes: input.notes ?? null,
    });
}

/**
 * Insert a room tag ONLY if the image has no tag yet — never overwrites.
 * Unlike setImageTag, this cannot clobber a tag written by a human (UI
 * PATCH /api/images/[id]/tag, or `tag:set`) after a caller snapshotted its
 * work list but before it got around to writing this particular image.
 * Returns whether a row was actually inserted.
 */
export function setImageTagIfAbsent(input: {
  imageId: string;
  roomType: RoomType;
  confidence?: number | null;
  notes?: string | null;
  taggedBy?: string;
}): boolean {
  const exists = sqlite
    .prepare("SELECT 1 FROM images WHERE id = ?")
    .get(input.imageId);
  if (!exists) throw new Error(`No image with id ${input.imageId}`);
  const result = sqlite
    .prepare(
      `INSERT INTO image_tags (image_id, room_type, confidence, tagged_by, tagged_at, notes)
       VALUES (@imageId, @roomType, @confidence, @taggedBy, @taggedAt, @notes)
       ON CONFLICT(image_id) DO NOTHING`,
    )
    .run({
      imageId: input.imageId,
      roomType: input.roomType,
      confidence: input.confidence ?? null,
      taggedBy: input.taggedBy ?? "claude-code",
      taggedAt: new Date().toISOString(),
      notes: input.notes ?? null,
    });
  return result.changes > 0;
}

/** Find an existing group by case-insensitive label, or create one. */
export function ensureGroup(input: {
  label: string;
  roomType?: string | null;
}): { groupId: string; created: boolean } {
  const existing = sqlite
    .prepare("SELECT id FROM similarity_groups WHERE label = ? COLLATE NOCASE")
    .get(input.label) as { id: string } | undefined;
  if (existing) return { groupId: existing.id, created: false };

  const id = `grp_${Math.abs(hash(input.label)).toString(36)}_${Date.now().toString(36)}`;
  sqlite
    .prepare(
      `INSERT INTO similarity_groups (id, label, room_type, created_at)
       VALUES (?,?,?,?)`,
    )
    .run(id, input.label, input.roomType ?? null, new Date().toISOString());
  return { groupId: id, created: true };
}

export function addGroupMember(groupId: string, imageId: string): void {
  const g = sqlite
    .prepare("SELECT 1 FROM similarity_groups WHERE id = ?")
    .get(groupId);
  if (!g) throw new Error(`No group with id ${groupId}`);
  const img = sqlite.prepare("SELECT 1 FROM images WHERE id = ?").get(imageId);
  if (!img) throw new Error(`No image with id ${imageId}`);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO similarity_group_members (group_id, image_id, added_at)
       VALUES (?,?,?)`,
    )
    .run(groupId, imageId, new Date().toISOString());
}

export interface TagStatus {
  totalImages: number;
  tagged: number;
  untagged: number;
  byRoom: Record<string, number>;
  groups: { id: string; label: string; members: number }[];
}

export function tagStatus(): TagStatus {
  const total = (
    sqlite.prepare("SELECT COUNT(*) c FROM images").get() as { c: number }
  ).c;
  const tagged = (
    sqlite
      .prepare("SELECT COUNT(*) c FROM image_tags WHERE room_type IS NOT NULL")
      .get() as { c: number }
  ).c;
  const rooms = sqlite
    .prepare(
      "SELECT room_type rt, COUNT(*) c FROM image_tags WHERE room_type IS NOT NULL GROUP BY room_type",
    )
    .all() as { rt: string; c: number }[];
  const groups = sqlite
    .prepare(
      `SELECT g.id, g.label, COUNT(m.image_id) members
       FROM similarity_groups g
       LEFT JOIN similarity_group_members m ON m.group_id = g.id
       GROUP BY g.id ORDER BY g.label`,
    )
    .all() as { id: string; label: string; members: number }[];
  return {
    totalImages: total,
    tagged,
    untagged: total - tagged,
    byRoom: Object.fromEntries(rooms.map((r) => [r.rt, r.c])),
    groups,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h | 0;
}
