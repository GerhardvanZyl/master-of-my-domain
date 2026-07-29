import Database from "better-sqlite3";
const db = new Database("data/app.db");
// verify the non-index-1 covers landed on the expected image filename
for (const [ext, want] of [["2020363145", "2020363145_9_"], ["2020856274", "2020856274_25_"], ["2020926903", "2020926903_5_"], ["2020953505", "18088113_1_"]] as const) {
  const p = db.prepare("SELECT id FROM properties WHERE external_id=?").get(ext) as any;
  const hero = db.prepare("SELECT i.source_url FROM image_tags t JOIN images i ON i.id=t.image_id WHERE t.notes='hero' AND i.property_id=?").get(p.id) as any;
  const fn = hero ? (hero.source_url.split("/").pop() ?? "") : "(none)";
  console.log(ext, "want", want, "=>", fn.startsWith(want) ? "OK " + fn : "MISMATCH " + fn);
}
