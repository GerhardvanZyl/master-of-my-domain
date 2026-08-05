import Database from "better-sqlite3";
const db = new Database("data/app.db", { readonly: true });

// Mirrors src/db/queries/properties.ts — keep in sync if that changes.
const aspect = (w, h) => (w && h ? w / h : null);
const isPropertyPhoto = (w, h) => {
  const a = aspect(w, h);
  if (a == null || !w || !h) return true;
  if (Math.max(w, h) < 500) return false;
  if (a >= 2.2 || a <= 0.45) return false;
  return !(a > 0.95 && a < 1.05);
};
const isVisibleImage = (i) => {
  if (i.rt === "exclude") return false;
  if (i.notes === "floorplan" || i.notes === "hero") return true;
  return isPropertyPhoto(i.w, i.h);
};
const shapeSaysFloorplan = (w, h) => {
  const a = aspect(w, h);
  return a != null && (a < 0.92 || (a > 1.37 && a < 1.46));
};

const rows = db
  .prepare(
    `SELECT i.property_id pid, i.width w, i.height h, t.room_type rt, t.notes,
            p.address, p.suburb, COALESCE(p.state,'') state
       FROM images i
       LEFT JOIN image_tags t ON t.image_id = i.id
       JOIN properties p ON p.id = i.property_id`,
  )
  .all();

const byProp = new Map();
for (const r of rows) {
  if (!byProp.has(r.pid)) byProp.set(r.pid, { address: r.address, suburb: r.suburb, state: r.state, imgs: [] });
  byProp.get(r.pid).imgs.push(r);
}

let explicit = 0, viaShape = 0, none = 0;
const noneList = [];
for (const [, p] of byProp) {
  const visible = p.imgs.filter(isVisibleImage);
  if (visible.some((i) => i.notes === "floorplan")) explicit++;
  else if (visible.some((i) => shapeSaysFloorplan(i.w, i.h))) viaShape++;
  else {
    none++;
    noneList.push(p);
  }
}

console.log("properties with images:", byProp.size);
console.log("  floorplan via explicit notes='floorplan':", explicit);
console.log("  floorplan via shape heuristic only:      ", viaShape);
console.log("  NO floorplan at all:                     ", none);
console.log("  => coverage:", (((explicit + viaShape) / byProp.size) * 100).toFixed(1) + "%");

const bySub = {};
for (const p of noneList) bySub[p.suburb] = (bySub[p.suburb] || 0) + 1;
console.log("\nno floorplan, by suburb:", JSON.stringify(bySub));
console.log("(NSW rows are frozen and excluded from remediation)");
