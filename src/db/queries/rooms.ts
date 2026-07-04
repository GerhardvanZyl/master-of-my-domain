import { sqlite } from "../client";

export interface RoomImage {
  id: string;
  localPath: string;
  propertyId: string;
  address: string | null;
  roomType: string | null;
}

export interface PropertyColumn {
  propertyId: string;
  address: string | null;
  images: RoomImage[];
}

function groupByProperty(rows: RoomImage[]): PropertyColumn[] {
  const cols = new Map<string, PropertyColumn>();
  for (const r of rows) {
    let c = cols.get(r.propertyId);
    if (!c) {
      c = { propertyId: r.propertyId, address: r.address, images: [] };
      cols.set(r.propertyId, c);
    }
    c.images.push(r);
  }
  return [...cols.values()];
}

/** Room types present in the DB, with image counts. */
export function roomTypeCounts(): { roomType: string; count: number }[] {
  return sqlite
    .prepare(
      `SELECT room_type AS roomType, COUNT(*) AS count
       FROM image_tags WHERE room_type IS NOT NULL
       GROUP BY room_type ORDER BY room_type`,
    )
    .all() as { roomType: string; count: number }[];
}

/** All photos of a room type, grouped into one column per property. */
export function imagesByRoom(roomType: string): PropertyColumn[] {
  const rows = sqlite
    .prepare(
      `SELECT i.id, i.local_path AS localPath, i.property_id AS propertyId,
        p.address AS address, t.room_type AS roomType
       FROM image_tags t
       JOIN images i ON i.id = t.image_id
       JOIN properties p ON p.id = i.property_id
       WHERE t.room_type = ?
       ORDER BY p.address, i.ordinal`,
    )
    .all(roomType) as RoomImage[];
  return groupByProperty(rows);
}

export interface GroupInfo {
  id: string;
  label: string;
  roomType: string | null;
  members: number;
}

export function listGroups(): GroupInfo[] {
  return sqlite
    .prepare(
      `SELECT g.id, g.label, g.room_type AS roomType, COUNT(m.image_id) AS members
       FROM similarity_groups g
       LEFT JOIN similarity_group_members m ON m.group_id = g.id
       GROUP BY g.id ORDER BY g.label`,
    )
    .all() as GroupInfo[];
}

/** A similarity group's members, one column per property. */
export function groupMembers(groupId: string): PropertyColumn[] {
  const rows = sqlite
    .prepare(
      `SELECT i.id, i.local_path AS localPath, i.property_id AS propertyId,
        p.address AS address, t.room_type AS roomType
       FROM similarity_group_members m
       JOIN images i ON i.id = m.image_id
       JOIN properties p ON p.id = i.property_id
       LEFT JOIN image_tags t ON t.image_id = i.id
       WHERE m.group_id = ?
       ORDER BY p.address, i.ordinal`,
    )
    .all(groupId) as RoomImage[];
  return groupByProperty(rows);
}
