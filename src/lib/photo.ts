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
