import Database from "better-sqlite3";
import { ensureGroup, addGroupMember } from "../src/db/queries/tags";
// Build cross-property comparison groups: one representative image per property
// per room type. Idempotent — never adds a 2nd image for a property already in
// the group. Prefers the property's hero if it's that room, else lowest ordinal.
const db = new Database("data/app.db");
const ROOMS = ["kitchen", "bathroom", "bedroom", "living", "dining", "exterior"];
const summary: Record<string, number> = {};
for (const room of ROOMS) {
  const { groupId } = ensureGroup({ label: room, roomType: room });
  const already = new Set(
    (db.prepare(
      `SELECT DISTINCT i.property_id pid FROM similarity_group_members m
       JOIN images i ON i.id=m.image_id WHERE m.group_id=?`,
    ).all(groupId) as { pid: string }[]).map((r) => r.pid),
  );
  // One candidate per property: hero-of-this-room first, else lowest ordinal.
  const cands = db.prepare(
    `SELECT i.property_id pid, i.id imageId,
            CASE WHEN t.notes='hero' THEN 0 ELSE 1 END heroRank, i.ordinal
     FROM images i JOIN image_tags t ON t.image_id=i.id
     WHERE t.room_type=?
     ORDER BY i.property_id, heroRank, i.ordinal`,
  ).all(room) as { pid: string; imageId: string }[];
  const pickedProp = new Set<string>();
  let added = 0;
  for (const c of cands) {
    if (already.has(c.pid) || pickedProp.has(c.pid)) continue;
    pickedProp.add(c.pid);
    addGroupMember(groupId, c.imageId);
    added++;
  }
  summary[room] = already.size + pickedProp.size;
}
console.log(JSON.stringify({ groupsMembersPerRoom: summary }, null, 1));
