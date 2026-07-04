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
`;
