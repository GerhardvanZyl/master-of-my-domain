// Shared, client-safe photo helpers (no DB imports).

// Kept in sync with src/db/schema.ts's ROOM_TYPES by hand — duplicated here
// (rather than imported) because that module also exports drizzle table
// definitions that must not end up in the client bundle.
export const ROOM_TYPES = [
  "kitchen",
  "bathroom",
  "bedroom",
  "living",
  "dining",
  "exterior",
  "other",
  "aerial",
  "exclude",
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/** Row order for the compare page's room-type rows. */
export const ROOM_ROW_ORDER: { key: string; label: string }[] = [
  { key: "kitchen", label: "Kitchen" },
  { key: "master", label: "Master bedroom" },
  { key: "bedroom", label: "Bedroom" },
  { key: "bathroom", label: "Bathroom" },
  { key: "living", label: "Living" },
  { key: "dining", label: "Dining" },
  { key: "exterior", label: "Exterior" },
  { key: "other", label: "Other" },
];

export interface PhotoLite {
  id: string;
  localPath: string;
  roomType: string | null;
  notes?: string | null;
  taggedBy?: string | null;
  confidence?: number | null;
  /** Stored pixel dimensions. Optional: callers pass ImageWithTag rows, which
   *  always carry them, but they're nullable in the DB. HeroGallery uses them
   *  to size its box to the photo instead of cropping the photo to a box. */
  width?: number | null;
  height?: number | null;
}

/** `tagged_by` values that mean "a machine picked this, nobody has reviewed it". */
const MACHINE_TAGGED_BY = new Set(["local-vlm", "migration"]);

export function isMachineTagged(taggedBy: string | null | undefined): boolean {
  return !!taggedBy && MACHINE_TAGGED_BY.has(taggedBy);
}

/** Human-readable form of image_tags.tagged_by, for the lightbox detail line. */
export function formatTaggedBy(taggedBy: string | null | undefined): string | null {
  if (!taggedBy) return null;
  switch (taggedBy) {
    case "claude-code":
      return "Claude Code";
    case "user":
      return "you";
    case "migration":
      return "a retag sweep";
    case "local-vlm":
      return "the vision model";
    case "domain-cover":
      return "Domain's cover heuristic";
    case "first-photo-heuristic":
      return "the first-photo heuristic";
    default:
      return taggedBy;
  }
}

// --- Image-selection policy (hero + gallery visibility) ---
//
// Moved from src/db/queries/properties.ts (arch-003, fix round 2 of
// 20260920-1449-bugfix): pickHero and isVisibleImage are pure shape/tag
// predicates with no DB access, but src/db/queries/properties.ts imports
// `db` from ../client at module scope, and src/db/client.ts opens and
// migrates data/app.db as an import-time side effect — so anything that only
// wanted this policy still paid for a live DB connection just by importing
// it. Re-exported from properties.ts below so no existing caller changes.

export function aspect(width: number | null, height: number | null): number | null {
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
