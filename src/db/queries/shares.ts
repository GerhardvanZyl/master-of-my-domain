import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../client";
import { shares } from "../schema";
import type { Share } from "../schema";
import { newId } from "@/lib/id";
import { listProperties, type PropertyListItem } from "./properties";

export interface ShareMeta {
  id: string;
  fromProfile: string;
  note: string | null;
  createdAt: string;
  readAt: string | null;
}

export type SharedListItem = PropertyListItem & { share: ShareMeta };

/**
 * Share (or re-share) a property with a profile. Upserts on (property_id,
 * to_profile) — re-sharing the same property to the same person bumps
 * created_at and clears read_at rather than piling up duplicate rows, so a
 * "hey look again" re-share reliably re-surfaces as unread.
 */
export function upsertShare(input: {
  propertyId: string;
  fromProfile: string;
  toProfile: string;
  note: string | null;
}): Share {
  const now = new Date().toISOString();
  db.insert(shares)
    .values({
      id: newId("share"),
      propertyId: input.propertyId,
      fromProfile: input.fromProfile,
      toProfile: input.toProfile,
      note: input.note,
      createdAt: now,
      readAt: null,
    })
    .onConflictDoUpdate({
      target: [shares.propertyId, shares.toProfile],
      set: { fromProfile: input.fromProfile, note: input.note, createdAt: now, readAt: null },
    })
    .run();
  return db
    .select()
    .from(shares)
    .where(and(eq(shares.propertyId, input.propertyId), eq(shares.toProfile, input.toProfile)))
    .get()!;
}

/** Unread share count for a profile — backs the header badge's poll. */
export function unreadShareCount(profile: string): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(shares)
    .where(and(eq(shares.toProfile, profile), isNull(shares.readAt)))
    .get();
  return row?.c ?? 0;
}

/**
 * Properties shared with a profile, in the same PropertyListItem shape
 * `listProperties()` uses (so the existing card/row components just work),
 * plus the share metadata. Unread first, newest first within each bucket.
 *
 * ponytail: re-runs listProperties() (a handful of full-table scans) rather
 * than a bespoke join — the inbox is a rarely-visited page over ~290 rows on
 * a local single-user DB, so the simplicity is worth more than the cycles.
 */
export function listSharesForProfile(profile: string): SharedListItem[] {
  const rows = db.select().from(shares).where(eq(shares.toProfile, profile)).all();
  if (rows.length === 0) return [];
  const byPropertyId = new Map(rows.map((r) => [r.propertyId, r]));
  return listProperties()
    .filter((p) => byPropertyId.has(p.id))
    .map((p) => {
      const s = byPropertyId.get(p.id)!;
      return {
        ...p,
        share: { id: s.id, fromProfile: s.fromProfile, note: s.note, createdAt: s.createdAt, readAt: s.readAt },
      };
    })
    .sort((a, b) => {
      const aUnread = a.share.readAt == null;
      const bUnread = b.share.readAt == null;
      if (aUnread !== bUnread) return aUnread ? -1 : 1;
      return b.share.createdAt.localeCompare(a.share.createdAt);
    });
}

/**
 * Mark specific shares read for a profile (opening the inbox marks only what
 * the GET actually returned — see the /api/shares/read route — so a share
 * that lands between the list fetch and this call stays unread rather than
 * being silently swallowed).
 */
export function markSharesRead(profile: string, ids: string[]): void {
  if (ids.length === 0) return;
  db.update(shares)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(shares.toProfile, profile), inArray(shares.id, ids)))
    .run();
}
