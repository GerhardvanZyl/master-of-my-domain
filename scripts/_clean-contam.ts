import "../src/lib/load-env";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../src/db/client";
import { IMAGES_DIR } from "../src/lib/env";
const scratch = "C:/Users/vanzy/AppData/Local/Temp/claude/E--Projects-2024-master-of-my-domain/a49b4448-62e1-490e-8342-ffd6055e5d86/scratchpad";
const marker = readFileSync(scratch + "/marker.txt", "utf8").trim();
const news = sqlite.prepare(`SELECT id, external_id ext FROM properties WHERE created_at >= ? AND (listing_url LIKE '%point-cook-vic-3030%' OR listing_url LIKE '%williams-landing-vic-3027%')`).all(marker) as any[];
const imgs = sqlite.prepare("SELECT id, source_url, local_path FROM images WHERE property_id = ?");
const del = sqlite.prepare("DELETE FROM images WHERE id = ?");
let removed = 0, kept = 0;
const report: any[] = [];
for (const p of news) {
  const rows = imgs.all(p.id) as any[];
  let r = 0, k = 0;
  for (const im of rows) {
    const bn = (im.source_url || "").split("/").pop().split("?")[0];
    if (bn.startsWith(p.ext + "_")) { k++; continue; }
    // contamination: agent logo / contact / other-listing image
    del.run(im.id);
    try { if (im.local_path) fs.unlinkSync(path.join(process.cwd(), im.local_path)); } catch {}
    r++;
  }
  removed += r; kept += k;
  report.push({ ext: p.ext, kept: k, removed: r });
}
console.log(JSON.stringify({ removed, kept, report }, null, 0));
