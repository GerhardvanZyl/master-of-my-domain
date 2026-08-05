import "../src/lib/load-env";
import { sqlite } from "../src/db/client";
import { ensureGroup, addGroupMember } from "../src/db/queries/tags";

/**
 * Top up the six room comparison groups: for every property that has a photo of
 * a room type but no representative in that room's group, add its lowest-ordinal
 * photo of that type. One image per property per group (the app renders one
 * column per property). Idempotent — re-running adds nothing.
 */
const ROOMS = ["kitchen", "bathroom", "bedroom", "living", "dining", "exterior"] as const;

const repImg = sqlite.prepare(
  `SELECT i.id FROM images i
     JOIN image_tags it ON it.image_id = i.id
    WHERE i.property_id = ? AND it.room_type = ?
    ORDER BY i.ordinal LIMIT 1`,
);

const missing = sqlite.prepare(
  `SELECT DISTINCT i.property_id AS pid
     FROM images i
     JOIN image_tags it ON it.image_id = i.id
    WHERE it.room_type = ?
      AND i.property_id NOT IN (
        SELECT i2.property_id FROM similarity_group_members m
          JOIN images i2 ON i2.id = m.image_id
         WHERE m.group_id = ?)`,
);

let added = 0;
const perRoom: Record<string, number> = {};
for (const room of ROOMS) {
  const { groupId } = ensureGroup({ label: room, roomType: room });
  const props = missing.all(room, groupId) as { pid: string }[];
  let n = 0;
  for (const p of props) {
    const im = repImg.get(p.pid, room) as { id: string } | undefined;
    if (im) {
      addGroupMember(groupId, im.id);
      n++;
      added++;
    }
  }
  perRoom[room] = n;
  console.log(`${room.padEnd(9)} +${n}`);
}
console.log("total added:", added);

for (const room of ROOMS) {
  const { groupId } = ensureGroup({ label: room, roomType: room });
  const n = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT i.property_id) n FROM similarity_group_members m
         JOIN images i ON i.id = m.image_id WHERE m.group_id = ?`,
    )
    .get(groupId) as { n: number };
  console.log(`${room.padEnd(9)} now ${n.n} properties`);
}
