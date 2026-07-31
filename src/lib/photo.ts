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
}
