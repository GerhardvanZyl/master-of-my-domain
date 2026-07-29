import "../src/lib/load-env";
import { writeFileSync } from "node:fs";
import { sqlite } from "../src/db/client";
// Properties whose hero is still the first-photo-heuristic fallback (need exact og:image).
const rows = sqlite.prepare(`
  SELECT p.id, p.external_id ext, p.listing_url url
  FROM properties p
  WHERE p.listing_url LIKE '%domain.com.au%'
    AND EXISTS(SELECT 1 FROM image_tags it JOIN images i ON i.id=it.image_id
               WHERE i.property_id=p.id AND it.notes='hero' AND it.tagged_by='first-photo-heuristic')
`).all() as any[];
const scratch = "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/a49b4448-62e1-490e-8342-ffd6055e5d86/scratchpad";
const compact = rows.map(r => [r.ext, r.url.replace("https://www.domain.com.au", "")]);
writeFileSync(scratch + "/heroneed2.json", JSON.stringify(compact));
console.log("still-heuristic:", rows.length);
