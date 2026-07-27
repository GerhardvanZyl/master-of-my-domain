import "../src/lib/load-env";
import { sqlite } from "../src/db/client";
// The 11 new listings. Domain cover = photoIndex 1 (7 confirmed via og:image this
// session, 31-solitude confirmed earlier; all new PC listings lead facade @ index 1).
const NEW_EXTS = ["2021019698","2021017542","2021022852","2021016249","2021020062","2021014749","2021022838","2021017752","2021019617","2021025994","2020910894"];
const now = new Date().toISOString();
const getProp = sqlite.prepare("SELECT id, address FROM properties WHERE external_id=?");
const getImgs = sqlite.prepare("SELECT id, source_url su, ordinal FROM images WHERE property_id=? ORDER BY ordinal");
const clearHero = sqlite.prepare("UPDATE image_tags SET notes=NULL WHERE notes='hero' AND image_id IN (SELECT id FROM images WHERE property_id=?)");
const hasTag = sqlite.prepare("SELECT 1 FROM image_tags WHERE image_id=?");
const updTag = sqlite.prepare("UPDATE image_tags SET notes='hero' WHERE image_id=?");
const insTag = sqlite.prepare("INSERT INTO image_tags (image_id, notes, tagged_by, tagged_at) VALUES (?, 'hero', 'domain-cover', ?)");
const setHero = sqlite.transaction((pid: string, imgId: string) => {
  clearHero.run(pid);
  if (hasTag.get(imgId)) updTag.run(imgId); else insTag.run(imgId, now);
});
const report: any[] = [];
for (const ext of NEW_EXTS) {
  const p = getProp.get(ext) as any;
  if (!p) { report.push({ ext, err: "no prop" }); continue; }
  const imgs = getImgs.all(p.id) as any[];
  const base = (su: string) => (su.split("/").pop() || "").split("?")[0];
  let hit = imgs.find(i => base(i.su).startsWith(ext + "_1_"));
  let via = "index-1";
  if (!hit) { // fallback: lowest-index real photo of this listing
    hit = imgs.find(i => base(i.su).startsWith(ext + "_"));
    via = "fallback-lowest";
  }
  if (!hit) { report.push({ ext, err: "no matching image", imgs: imgs.length }); continue; }
  setHero(p.id, hit.id);
  report.push({ ext, addr: p.address, hero: base(hit.su), via });
}
console.log(JSON.stringify(report, null, 1));
