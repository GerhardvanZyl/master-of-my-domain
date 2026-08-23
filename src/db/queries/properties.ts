import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { properties, images, imageTags, scrapeJobs, priceHistory, propertyRatings } from "../schema";
import type { Property, PriceHistory, PropertyRating } from "../schema";
import { IMAGES_DIR } from "@/lib/env";
import { priorityScore } from "@/lib/priority";

/**
 * Grid row. `raw_json` + `description` are deliberately absent: PropertyGrid is
 * a client component, so every column it receives is serialised into the RSC
 * payload twice (HTML + flight data) for ~290 rows — those two fields alone
 * were 234KB of the 709KB payload and nothing on the grid reads them. The
 * detail/compare pages fetch the full row via getProperty/getPropertiesByIds.
 */
export interface PropertyListItem extends Omit<Property, "rawJson" | "description"> {
  imageCount: number;
  thumbPath: string | null;
  /** Listing no longer appears in Domain search results (sold/withdrawn). */
  delisted: boolean;
  /** Specific removal reason when known: "sold" | "withdrawn" | "delisted". */
  saleStatus: string | null;
  /** Most recent price_history row that carries an actual amount (price fallback). */
  lastPricedEvent: { event: string | null; date: string | null; priceDisplay: string | null } | null;
  /**
   * Real sale date ("YYYY-MM-DD") of the most recent event whose name starts
   * with "Sold" — set even when there's no price (price-withheld sales still
   * get a dated 'Sold' row via `npm run mark-sold`). Deliberately NOT sourced
   * from `lastPricedEvent`, which filters to rows carrying a `$` amount and
   * would silently drop price-withheld sales.
   */
  soldDate: string | null;
  ratings: Pick<PropertyRating, "profile" | "vibe" | "look" | "kitchen" | "size" | "score">[];
}

/** scrape_jobs.status values that mean the listing is no longer for sale. */
const DELISTED_STATUSES = ["delisted", "sold", "withdrawn"];

function aspect(width: number | null, height: number | null): number | null {
  return width && height ? width / height : null;
}

/**
 * A photo of the property or its surrounds, as opposed to the marketing junk
 * agents pad the gallery with. Verified against the ~7.8k stored images:
 *   - agent headshots are 120–180px squares, agent "cards" are 1080px squares
 *   - agency logos are wide strips (720×50, 120×42)
 *   - real Domain photos are 3:2 (1620×1080)
 * Square (1.00 aspect) is treated as agent-card junk here, but Domain also
 * serves plenty of genuine floorplans at exactly 1080×1080 — this heuristic
 * can't tell those apart from shape alone, so it doesn't try. A curated
 * notes='floorplan'/'hero' tag overrides this in getPropertyImages() (see
 * isVisibleImage below); don't loosen the aspect check itself, or real agent
 * cards leak back into every gallery.
 * Drops 1959 of 7770 images and leaves every property with at least one photo.
 * Dimensions are unknown for nothing in the DB today; if that changes, keep the
 * image rather than hide it.
 */
export function isPropertyPhoto(
  width: number | null,
  height: number | null,
): boolean {
  const a = aspect(width, height);
  if (a == null || !width || !height) return true;
  if (Math.max(width, height) < 500) return false; // headshots, icons, small logos
  if (a >= 2.2 || a <= 0.45) return false; // banner strips
  return !(a > 0.95 && a < 1.05); // square = agent card / logo
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

/**
 * Domain encodes its own gallery order in the CDN filename:
 *   `<listingId>_<photoIndex>_<crop>_<date>...` (e.g. `2017917468_1_1_221014-…`).
 * photoIndex 1 is the cover Domain leads with; higher indices come later in the
 * gallery (floorplans/aerials last). We use listingId to drop cross-listing
 * contamination (an agent's other listings leak into ingest) and photoIndex to
 * lead with the same photo Domain does. Older/REA captures don't match → null,
 * and those fall back to the aspect heuristic in listing order.
 */
export function urlIds(
  sourceUrl?: string | null,
): { listingId: string; photoIndex: number } | null {
  const m = (sourceUrl?.split("/").pop() ?? "").match(/^(\d+)_(\d+)_\d+_/);
  return m ? { listingId: m[1], photoIndex: Number(m[2]) } : null;
}

/**
 * A real landscape photo usable as a fallback hero: excludes A-paper floorplans
 * (~1.41) and wide banner strips / logos (aspect ≥ 2). Used only when a listing
 * has no clean 3:2 shot (e.g. acreage led with a 16:9 aerial).
 */
function isRealLandscape(width: number | null, height: number | null): boolean {
  const a = aspect(width, height);
  return a != null && a >= 1 && a < 2 && !(a > 1.37 && a < 1.46);
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
 * Domain's gallery alt text carries its own cover index: `"{address}, Image N"`
 * (N=0 is the cover). Tolerant to extra whitespace / casing; anchored on the
 * trailing counter so it doesn't misfire on an address that happens to contain
 * the word "image" elsewhere.
 */
const ALT_IMAGE_INDEX_RE = /\bimage\s*(\d+)\s*$/i;

function altIndex(alt: string | null | undefined): number | null {
  if (!alt) return null;
  const m = alt.match(ALT_IMAGE_INDEX_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Hero image: an explicit pick (notes='hero') wins; else the lowest "Image N"
 * index parsed from Domain's own alt text; else the photo Domain leads with —
 * its lowest-photoIndex 3:2 shot; else the lowest-index real landscape (16:9
 * aerial etc.); else the first image. Cover candidates are restricted to the
 * listing's dominant listingId so contamination (e.g. "similar listings"
 * thumbnails, which carry a different address and their own Image 0) and
 * floorplans/logos can't win.
 */
export function pickHero<
  T extends {
    width: number | null;
    height: number | null;
    notes?: string | null;
    sourceUrl?: string | null;
    alt?: string | null;
    roomType?: string | null;
  },
>(rawImgs: T[]): T | null {
  // Defence in depth: an image tagged `exclude` must never become the hero,
  // even if some caller forgot to pre-filter its input (see room-classify.ts
  // / schema.ts on what `exclude` means) and even against an explicit
  // notes='hero' pick — exclude means "never shown", full stop.
  const imgs = rawImgs.filter((i) => i.roomType !== "exclude");
  const explicit = imgs.find((i) => i.notes === "hero");
  if (explicit) return explicit;
  const lid = (i: T) => urlIds(i.sourceUrl)?.listingId ?? null;
  const photoIdx = (i: T) => urlIds(i.sourceUrl)?.photoIndex ?? Number.MAX_SAFE_INTEGER;
  // Lowest index (per `idx`) among candidates sharing the dominant listingId —
  // the listingId itself always comes from the CDN filename, even when ranking
  // by alt index, so contamination is dropped the same way for every rung.
  const pickFrom = (cands: T[], idx: (i: T) => number): T | null => {
    if (!cands.length) return null;
    const counts = new Map<string, number>();
    for (const c of cands) {
      const id = lid(c);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const dom = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const own = dom ? cands.filter((c) => lid(c) === dom) : cands;
    return own.reduce((a, b) => (idx(a) <= idx(b) ? a : b));
  };
  return (
    pickFrom(
      imgs.filter((i) => altIndex(i.alt) != null),
      (i) => altIndex(i.alt) ?? Number.MAX_SAFE_INTEGER,
    ) ??
    pickFrom(imgs.filter((i) => isHeroPhoto(i.width, i.height)), photoIdx) ??
    pickFrom(imgs.filter((i) => isRealLandscape(i.width, i.height)), photoIdx) ??
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
      alt: images.alt,
      notes: imageTags.notes,
      roomType: imageTags.roomType,
    })
    .from(images)
    .leftJoin(imageTags, eq(imageTags.imageId, images.id))
    .orderBy(images.ordinal)
    .all();

  // Group images per property (kept in ordinal order) so the grid thumbnail uses
  // the exact same pickHero as the detail page — one source of truth.
  const counts = new Map<string, number>();
  const byProp = new Map<string, (typeof imgs)[number][]>();
  for (const i of imgs) {
    if (i.roomType === "exclude") continue; // never counted, never a hero candidate
    // Count only what the gallery will actually show (see getPropertyImages),
    // so the card's "N photos" badge matches the carousel.
    if (isPropertyPhoto(i.width, i.height)) {
      counts.set(i.propertyId, (counts.get(i.propertyId) ?? 0) + 1);
    }
    (byProp.get(i.propertyId) ?? byProp.set(i.propertyId, []).get(i.propertyId)!).push(i);
  }
  const thumbOf = (id: string): string | null =>
    pickHero(byProp.get(id) ?? [])?.localPath ?? null;

  const ratingRows = db
    .select({
      propertyId: propertyRatings.propertyId,
      profile: propertyRatings.profile,
      vibe: propertyRatings.vibe,
      look: propertyRatings.look,
      kitchen: propertyRatings.kitchen,
      size: propertyRatings.size,
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
      size: r.size,
      score: r.score,
    });
    ratingsByProp.set(r.propertyId, arr);
  }

  // Listings flagged as no longer in search results (sold/withdrawn) — tracked in
  // scrape_jobs rather than deleting the row, so ratings/notes survive.
  const delistedStatus = new Map(
    db
      .select({ url: scrapeJobs.url, status: scrapeJobs.status })
      .from(scrapeJobs)
      .where(inArray(scrapeJobs.status, DELISTED_STATUSES))
      .all()
      .map((r) => [r.url, r.status] as const),
  );

  // Last sale/listing event that carries a real dollar amount. The grid falls
  // back to this when Domain has replaced the guide with a bare status.
  const lastPriced = new Map<string, PropertyListItem["lastPricedEvent"]>();
  for (const h of db
    .select({
      propertyId: priceHistory.propertyId,
      event: priceHistory.event,
      date: priceHistory.date,
      priceDisplay: priceHistory.priceDisplay,
    })
    .from(priceHistory)
    .orderBy(priceHistory.date)
    .all()) {
    if (!/\$\s?[\d,]/.test(h.priceDisplay ?? "")) continue;
    if (/rent|lease/i.test(h.event ?? "")) continue;
    // Rows come back oldest-first, so the last write wins = most recent.
    lastPriced.set(h.propertyId, { event: h.event, date: h.date, priceDisplay: h.priceDisplay });
  }

  // Real sale date, independent of whether a price is known — deliberately a
  // separate pass from lastPriced above (see PropertyListItem.soldDate doc).
  const soldDateByProp = new Map<string, string>();
  for (const h of db
    .select({
      propertyId: priceHistory.propertyId,
      event: priceHistory.event,
      date: priceHistory.date,
    })
    .from(priceHistory)
    .orderBy(priceHistory.date)
    .all()) {
    if (!/^sold/i.test(h.event ?? "")) continue;
    if (!h.date) continue;
    // Rows come back oldest-first, so the last write wins = most recent.
    soldDateByProp.set(h.propertyId, h.date);
  }

  return props
    .map(({ rawJson: _raw, description: _desc, ...p }) => ({
      ...p,
      imageCount: counts.get(p.id) ?? 0,
      thumbPath: thumbOf(p.id),
      delisted: delistedStatus.has(p.listingUrl),
      saleStatus: delistedStatus.get(p.listingUrl) ?? null,
      lastPricedEvent: lastPriced.get(p.id) ?? null,
      soldDate: soldDateByProp.get(p.id) ?? null,
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

/** Existence check without pulling raw_json/description (see PropertyListItem note above). */
export function propertyExists(id: string): boolean {
  return db.select({ id: properties.id }).from(properties).where(eq(properties.id, id)).get() != null;
}

/** Removal status for a listing URL: "sold" | "withdrawn" | "delisted" | null. */
export function getSaleStatus(listingUrl: string): string | null {
  const row = db
    .select({ status: scrapeJobs.status })
    .from(scrapeJobs)
    .where(
      and(
        eq(scrapeJobs.url, listingUrl),
        inArray(scrapeJobs.status, DELISTED_STATUSES),
      ),
    )
    .get();
  return row?.status ?? null;
}

/** True if this listing URL has been flagged sold/withdrawn (scrape_jobs). */
export function isDelisted(listingUrl: string): boolean {
  return getSaleStatus(listingUrl) !== null;
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
      size: propertyRatings.size,
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
    arr.push({
      profile: r.profile,
      vibe: r.vibe,
      look: r.look,
      kitchen: r.kitchen,
      size: r.size,
      score: r.score,
    });
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
  alt: string | null;
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
  confidence: number | null;
}

/**
 * Whether an image belongs in the app's galleries at all — the single
 * predicate behind getPropertyImages(). Pure (no DB access) so it's testable
 * without a database.
 *
 * Order matters:
 *   1. `exclude` is absolute — a display-control tag (agency branding, logo
 *      cards, pure text/marketing panels) that must never be shown anywhere,
 *      no matter what any other tag says. Checked first and unconditionally.
 *   2. A curated notes='floorplan'/'hero' tag then overrides the shape
 *      heuristic — it's how genuine square (1080×1080) floorplans survive
 *      isPropertyPhoto's "square = agent card" rule (see that doc comment).
 *   3. Otherwise fall back to the aspect-ratio heuristic.
 */
export function isVisibleImage(i: {
  width: number | null;
  height: number | null;
  roomType?: string | null;
  notes?: string | null;
}): boolean {
  if (i.roomType === "exclude") return false;
  if (i.notes === "floorplan" || i.notes === "hero") return true;
  return isPropertyPhoto(i.width, i.height);
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
      alt: images.alt,
      roomType: imageTags.roomType,
      notes: imageTags.notes,
      taggedBy: imageTags.taggedBy,
      confidence: imageTags.confidence,
    })
    .from(images)
    .leftJoin(imageTags, eq(imageTags.imageId, images.id))
    .where(eq(images.propertyId, propertyId))
    .orderBy(images.ordinal)
    .all()
    // Galleries, lightboxes and the room compare all read through here, so one
    // filter keeps agent headshots and agency logos out of every carousel
    // while still rescuing curated picks (see isVisibleImage). Tagging
    // scripts talk to the DB directly and still see everything.
    .filter(isVisibleImage);
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
