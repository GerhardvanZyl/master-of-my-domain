import "../src/lib/load-env";
import { readFileSync } from "node:fs";
import { sqlite } from "../src/db/client";
import { ensureGroup, addGroupMember } from "../src/db/queries/tags";
const scratch = "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/a49b4448-62e1-490e-8342-ffd6055e5d86/scratchpad";
const marker = readFileSync(scratch + "/marker.txt", "utf8").trim();
const ROOMS = ["kitchen", "bathroom", "bedroom", "living", "dining", "exterior"];
const groupId: Record<string, string> = {};
for (const r of ROOMS) groupId[r] = ensureGroup({ label: r, roomType: r }).groupId;
const news = sqlite.prepare(`SELECT id, address FROM properties WHERE created_at >= ? AND (listing_url LIKE '%point-cook-vic-3030%' OR listing_url LIKE '%williams-landing-vic-3027%')`).all(marker) as any[];
// lowest-ordinal image of a given room type for a property (its representative)
const repImg = sqlite.prepare(`SELECT i.id FROM images i JOIN image_tags it ON it.image_id=i.id WHERE i.property_id=? AND it.room_type=? ORDER BY i.ordinal LIMIT 1`);
let added = 0; const report: any[] = [];
for (const p of news) {
  const per: Record<string, number> = {};
  for (const r of ROOMS) {
    const im = repImg.get(p.id, r) as any;
    if (im) { addGroupMember(groupId[r], im.id); per[r] = 1; added++; }
  }
  report.push({ addr: p.address, rooms: Object.keys(per) });
}
console.log(JSON.stringify({ added, groupIds: groupId, report }, null, 1));
