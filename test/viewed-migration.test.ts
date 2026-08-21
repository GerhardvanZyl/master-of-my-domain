/**
 * The attended_at + shortlist_tag='must-see' -> `viewed` consolidation.
 *
 * Builds a real pre-migration DB by applying the current DDL and then undoing
 * the two schema changes (rename back, drop the column), so the "old shape"
 * can't drift away from what the migration actually meets in the wild.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DDL, migrateColumns } from "../src/db/ddl";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewed-mig-"));
const db = new Database(path.join(dir, "old.db"));

db.exec(DDL);
db.exec("ALTER TABLE properties RENAME COLUMN viewed_at TO attended_at");
db.exec("ALTER TABLE properties DROP COLUMN viewed");

const insert = db.prepare(
  `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at, attended_at, shortlist_tag)
   VALUES (?, 'domain', ?, '2026-01-01', '2026-01-01', '2026-01-01', ?, ?)`,
);
insert.run("a", "https://x/a", "2026-08-01T00:00:00.000Z", null); // attended
insert.run("b", "https://x/b", null, "must-see"); // wanted
insert.run("c", "https://x/c", null, "maybe"); // untouched tag
insert.run("d", "https://x/d", null, null); // neither
insert.run("e", "https://x/e", "2026-07-04T00:00:00.000Z", "must-see"); // both

migrateColumns(db);

const rows = new Map(
  db
    .prepare("SELECT id, viewed, viewed_at, shortlist_tag FROM properties")
    .all()
    .map((r) => [(r as { id: string }).id, r as Record<string, unknown>]),
);

assert.equal(rows.get("a")!.viewed, "viewed", "attended_at became viewed");
assert.equal(rows.get("a")!.viewed_at, "2026-08-01T00:00:00.000Z", "the date came across the rename");
assert.equal(rows.get("b")!.viewed, "to-view", "must-see became to-view");
assert.equal(rows.get("c")!.viewed, null);
assert.equal(rows.get("c")!.shortlist_tag, "maybe", "maybe/rejected are left alone");
assert.equal(rows.get("d")!.viewed, null);
assert.equal(rows.get("e")!.viewed, "viewed", "been-there wins over want-to-go");
for (const id of ["a", "b", "e"]) {
  assert.equal(rows.get(id)!.shortlist_tag, null, `must-see cleared from ${id}`);
}

// Idempotent, and — the thing that matters — it must NOT re-derive state on a
// later connect: clearing `viewed` by hand has to stick even while viewed_at
// still holds the date, or the user could never un-view a property.
db.prepare("UPDATE properties SET viewed = NULL WHERE id = 'a'").run();
migrateColumns(db);
migrateColumns(db);
assert.equal(
  (db.prepare("SELECT viewed FROM properties WHERE id = 'a'").get() as { viewed: string | null }).viewed,
  null,
  "a cleared state is not resurrected by a re-run",
);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("✓ viewed-migration.test: all assertions passed");
