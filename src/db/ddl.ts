import type Database from "better-sqlite3";

/**
 * Idempotent schema DDL. Kept in one place and applied both by the migrate
 * script and automatically on every connection open (see client.ts), so the
 * dev server and CLI scripts always have the tables. Must stay in sync with
 * src/db/schema.ts.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS properties (
  id             TEXT PRIMARY KEY,
  source_site    TEXT NOT NULL,
  listing_url    TEXT NOT NULL UNIQUE,
  external_id    TEXT,
  address        TEXT,
  suburb         TEXT,
  state          TEXT,
  postcode       TEXT,
  price_display  TEXT,
  price_numeric  INTEGER,
  beds           INTEGER,
  baths          INTEGER,
  parking        INTEGER,
  land_size_sqm  REAL,
  property_type  TEXT,
  agent_name     TEXT,
  agency_name    TEXT,
  description    TEXT,
  latitude       REAL,
  longitude      REAL,
  nearest_station         TEXT,
  station_distance_m      INTEGER,
  second_station          TEXT,
  second_station_distance_m INTEGER,
  pt_minutes_to_flinders  INTEGER,
  pt_route_summary        TEXT,
  pt_steps                TEXT,
  adv_price_current           TEXT,
  adv_price_previous          TEXT,
  adv_price_previous_label    TEXT,
  next_inspection             TEXT,
  viewed_at                   TEXT,
  green_cross_distance_m      INTEGER,
  coles_distance_m            INTEGER,
  coles_name                  TEXT,
  playgrounds_500m            INTEGER,
  domain_notes                TEXT,
  ai_comment                  TEXT,
  has_eaves                   INTEGER,
  altitude_m                  REAL,
  flood_overlay               INTEGER,
  bushfire_overlay            INTEGER,
  master_bed_sqm              REAL,
  avg_other_bed_sqm           REAL,
  common_areas_count          INTEGER,
  balcony_sqm                 REAL,
  back_garden_sqm             REAL,
  pergola_covered             INTEGER,
  has_lawn                    INTEGER,
  lawn_type                   TEXT,
  shortlist_tag               TEXT,
  viewed                      TEXT,
  pros                        TEXT,
  cons                        TEXT,
  property_com_au_url         TEXT,
  year_built                  INTEGER,
  raw_json       TEXT,
  scraped_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  scrape_status  TEXT NOT NULL DEFAULT 'ok',
  scrape_error   TEXT
);

CREATE TABLE IF NOT EXISTS images (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source_url     TEXT NOT NULL,
  local_path     TEXT NOT NULL,
  content_hash   TEXT,
  ordinal        INTEGER NOT NULL,
  width          INTEGER,
  height         INTEGER,
  bytes          INTEGER,
  alt            TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(property_id, source_url)
);

CREATE TABLE IF NOT EXISTS image_tags (
  image_id       TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  room_type      TEXT,
  confidence     REAL,
  tagged_by      TEXT DEFAULT 'claude-code',
  tagged_at      TEXT NOT NULL,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS similarity_groups (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  room_type      TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT DEFAULT 'claude-code',
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS similarity_group_members (
  group_id       TEXT NOT NULL REFERENCES similarity_groups(id) ON DELETE CASCADE,
  image_id       TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (group_id, image_id)
);

CREATE TABLE IF NOT EXISTS property_ratings (
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  profile        TEXT NOT NULL,
  vibe           TEXT,
  look           TEXT,
  kitchen        TEXT,
  size           TEXT,
  score          REAL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (property_id, profile)
);

CREATE TABLE IF NOT EXISTS price_history (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date           TEXT,
  event          TEXT,
  price_display  TEXT,
  price_numeric  INTEGER,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_profile   TEXT NOT NULL,
  to_profile     TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL,
  read_at        TEXT,
  UNIQUE(property_id, to_profile)
);

CREATE TABLE IF NOT EXISTS settings (
  key            TEXT PRIMARY KEY,
  json           TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  status         TEXT NOT NULL,
  property_id    TEXT REFERENCES properties(id),
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_property ON images(property_id);
CREATE INDEX IF NOT EXISTS idx_images_hash ON images(content_hash);
CREATE INDEX IF NOT EXISTS idx_image_tags_room ON image_tags(room_type);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON similarity_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_image ON similarity_group_members(image_id);
CREATE INDEX IF NOT EXISTS idx_price_history_property ON price_history(property_id);
CREATE INDEX IF NOT EXISTS idx_shares_to_read ON shares(to_profile, read_at);
-- scrape_jobs is keyed by url in practice: every property page render looks up
-- its sale status by listing_url, and ingest upserts one row per url.
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_url ON scrape_jobs(url);
`;

/** Just enough of a better-sqlite3 handle to inspect and migrate a schema. */
type MigrationDb = Pick<Database.Database, "pragma" | "exec" | "transaction">;

type MigratedTable = "properties" | "property_ratings" | "images";

// The table name is a literal union, not a string: PRAGMA can't bind an
// identifier, and table_info of a table that does not exist returns an empty
// set rather than erroring, so a typo here would read as "nothing migrated".
function columnsOf(db: MigrationDb, table: MigratedTable): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
  );
}

/**
 * The migration statements this DB still needs, in the order they must run —
 * empty once it is fully migrated. Reads the schema and decides but writes
 * nothing, so it serves both as the "is there work?" test and as the work.
 */
function pendingMigrations(db: MigrationDb): string[] {
  const cols = columnsOf(db, "properties");
  const sql: string[] = [];

  // attended_at -> viewed_at. A rename, not an add-and-copy, so the dates come
  // across untouched and there is never a moment where both columns exist.
  if (cols.has("attended_at") && !cols.has("viewed_at")) {
    sql.push("ALTER TABLE properties RENAME COLUMN attended_at TO viewed_at");
    cols.delete("attended_at");
    cols.add("viewed_at");
  }

  const add: Record<string, string> = {
    nearest_station: "TEXT",
    station_distance_m: "INTEGER",
    second_station: "TEXT",
    second_station_distance_m: "INTEGER",
    pt_minutes_to_flinders: "INTEGER",
    pt_route_summary: "TEXT",
    pt_steps: "TEXT",
    adv_price_current: "TEXT",
    adv_price_previous: "TEXT",
    adv_price_previous_label: "TEXT",
    next_inspection: "TEXT",
    viewed_at: "TEXT",
    green_cross_distance_m: "INTEGER",
    coles_distance_m: "INTEGER",
    coles_name: "TEXT",
    playgrounds_500m: "INTEGER",
    domain_notes: "TEXT",
    ai_comment: "TEXT",
    has_eaves: "INTEGER",
    altitude_m: "REAL",
    flood_overlay: "INTEGER",
    bushfire_overlay: "INTEGER",
    master_bed_sqm: "REAL",
    avg_other_bed_sqm: "REAL",
    common_areas_count: "INTEGER",
    balcony_sqm: "REAL",
    back_garden_sqm: "REAL",
    pergola_covered: "INTEGER",
    has_lawn: "INTEGER",
    lawn_type: "TEXT",
    shortlist_tag: "TEXT",
    pros: "TEXT",
    cons: "TEXT",
    property_com_au_url: "TEXT",
    year_built: "INTEGER",
  };
  for (const [name, type] of Object.entries(add)) {
    if (!cols.has(name)) sql.push(`ALTER TABLE properties ADD COLUMN ${name} ${type}`);
  }

  // The three old inspection switches — attended_at, shortlist_tag='must-see'
  // and a per-browser localStorage set — collapse into one `viewed` enum.
  // "Been there" wins over "want to go" when a row somehow carried both.
  // Guarded on the column's absence so it runs exactly once per DB, and the
  // caller applies it all-or-nothing: a half-applied backfill would look
  // "already migrated" on the next connect and silently lose the rest.
  if (!cols.has("viewed")) {
    sql.push(
      "ALTER TABLE properties ADD COLUMN viewed TEXT",
      "UPDATE properties SET viewed = 'viewed'  WHERE viewed_at IS NOT NULL",
      "UPDATE properties SET viewed = 'to-view' WHERE viewed IS NULL AND shortlist_tag = 'must-see'",
      "UPDATE properties SET shortlist_tag = NULL WHERE shortlist_tag = 'must-see'",
    );
  }

  if (!columnsOf(db, "property_ratings").has("score")) {
    sql.push("ALTER TABLE property_ratings ADD COLUMN score REAL");
  }

  if (!columnsOf(db, "property_ratings").has("size")) {
    sql.push("ALTER TABLE property_ratings ADD COLUMN size TEXT");
  }

  if (!columnsOf(db, "images").has("alt")) {
    sql.push("ALTER TABLE images ADD COLUMN alt TEXT");
  }

  return sql;
}

/**
 * Add columns that CREATE TABLE IF NOT EXISTS can't retrofit onto an existing
 * DB. SQLite has no `ADD COLUMN IF NOT EXISTS`, so check table_info first.
 * Idempotent; safe to run on every connect, and on two connects at once — a
 * Next.js build opens one per parallel worker.
 *
 * `.immediate()` is what makes the check-then-act safe, and a plain `BEGIN`
 * would not: a deferred transaction takes its read snapshot *before* it takes
 * the write lock, so both processes still read the pre-migration column set
 * and the loser dies on `duplicate column name`. BEGIN IMMEDIATE takes the
 * lock first, so the re-read inside it is the one that decides. The unlocked
 * pre-check keeps the already-migrated case — nearly every call — lock-free;
 * it can only ever be stale towards doing the work, never towards skipping it,
 * because no step here is ever undone once committed.
 */
export function migrateColumns(db: MigrationDb): void {
  if (pendingMigrations(db).length === 0) return;
  db.transaction(() => {
    for (const statement of pendingMigrations(db)) db.exec(statement);
  }).immediate();
}
