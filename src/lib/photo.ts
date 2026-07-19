// Shared, client-safe photo helpers (no DB imports).

export const ROOM_TYPES = [
  "kitchen",
  "bathroom",
  "bedroom",
  "living",
  "dining",
  "exterior",
  "other",
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
