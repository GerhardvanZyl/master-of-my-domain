/**
 * The property_ratings.size column ("too small" rating, independent of the
 * kitchen axis) added on top of an existing DB that predates it.
 *
 * Modelled on test/viewed-migration.test.ts: build a DB from the current DDL,
 * then undo the one schema change under test, so the "old shape" this test
 * meets is exactly what migrateColumns has to handle in the wild.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DDL, migrateColumns } from "../src/db/ddl";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rating-size-mig-"));
const db = new Database(path.join(dir, "old.db"));

db.exec(DDL);
db.exec("ALTER TABLE property_ratings DROP COLUMN size");

const insertProp = db.prepare(
  `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
   VALUES (?, 'domain', ?, '2026-01-01', '2026-01-01', '2026-01-01')`,
);
insertProp.run("a", "https://x/a");

const insertRating = db.prepare(
  `INSERT INTO property_ratings (property_id, profile, vibe, look, kitchen, score, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, '2026-01-01')`,
);
insertRating.run("a", "gerhard", "like", "good", null, null);

migrateColumns(db);

const cols = (db.pragma("table_info(property_ratings)") as Array<{ name: string }>).map((c) => c.name);
assert.ok(cols.includes("size"), "size column added to an existing property_ratings table");

const row = db
  .prepare("SELECT vibe, look, size FROM property_ratings WHERE property_id = 'a'")
  .get() as { vibe: string; look: string; size: string | null };
assert.equal(row.vibe, "like", "pre-existing columns untouched by the migration");
assert.equal(row.look, "good", "pre-existing columns untouched by the migration");
assert.equal(row.size, null, "the new column starts NULL rather than backfilled");

// A property can now be rated "too small" and set the column.
db.prepare("UPDATE property_ratings SET size = 'small' WHERE property_id = 'a'").run();
assert.equal(
  (db.prepare("SELECT size FROM property_ratings WHERE property_id = 'a'").get() as { size: string }).size,
  "small",
);

// Idempotent: running again (already migrated) must not error or duplicate the column.
migrateColumns(db);
migrateColumns(db);
const colsAfter = (db.pragma("table_info(property_ratings)") as Array<{ name: string }>).filter(
  (c) => c.name === "size",
);
assert.equal(colsAfter.length, 1, "re-running the migration does not add the column twice");

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("✓ rating-size-migration.test: all assertions passed");
