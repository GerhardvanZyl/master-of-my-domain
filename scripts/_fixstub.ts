import "../src/lib/load-env";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../src/db/client";
const now = new Date().toISOString();
const pid = "568d950a-49e7-4067-8a03-94454de16a56";
const heroImg = "img_d7e80b7dfad4"; // 2020736637_1_1 = Domain cover
// set hero
sqlite.prepare("UPDATE image_tags SET notes=NULL WHERE notes='hero' AND image_id IN (SELECT id FROM images WHERE property_id=?)").run(pid);
if (sqlite.prepare("SELECT 1 FROM image_tags WHERE image_id=?").get(heroImg))
  sqlite.prepare("UPDATE image_tags SET notes='hero' WHERE image_id=?").run(heroImg);
else
  sqlite.prepare("INSERT INTO image_tags (image_id, notes, tagged_by, tagged_at) VALUES (?, 'hero', 'domain-cover', ?)").run(heroImg, now);
// delete the 2 contact-image rows + files
let removed = 0;
for (const id of ["img_d446a1f3d4f9", "img_0745acbd8f0e"]) {
  const r = sqlite.prepare("SELECT local_path lp FROM images WHERE id=?").get(id) as any;
  sqlite.prepare("DELETE FROM image_tags WHERE image_id=?").run(id);
  sqlite.prepare("DELETE FROM images WHERE id=?").run(id);
  try { if (r?.lp) fs.unlinkSync(path.join(process.cwd(), r.lp)); } catch {}
  removed++;
}
console.log(JSON.stringify({ heroSet: heroImg, contactRemoved: removed }));
