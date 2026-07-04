import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  unique,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/** Controlled vocabulary for room types. Enforced in app/CLI code. */
export const ROOM_TYPES = [
  "kitchen",
  "bathroom",
  "bedroom",
  "living",
  "dining",
  "exterior",
  "other",
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const SOURCE_SITES = ["domain", "rea"] as const;
export type SourceSite = (typeof SOURCE_SITES)[number];

export const properties = sqliteTable("properties", {
  id: text("id").primaryKey(),
  sourceSite: text("source_site").notNull(),
  listingUrl: text("listing_url").notNull().unique(),
  externalId: text("external_id"),
  address: text("address"),
  suburb: text("suburb"),
  state: text("state"),
  postcode: text("postcode"),
  priceDisplay: text("price_display"),
  priceNumeric: integer("price_numeric"),
  beds: integer("beds"),
  baths: integer("baths"),
  parking: integer("parking"),
  landSizeSqm: real("land_size_sqm"),
  propertyType: text("property_type"),
  agentName: text("agent_name"),
  agencyName: text("agency_name"),
  description: text("description"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  rawJson: text("raw_json"),
  scrapedAt: text("scraped_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  scrapeStatus: text("scrape_status").notNull().default("ok"),
  scrapeError: text("scrape_error"),
});

export const images = sqliteTable(
  "images",
  {
    id: text("id").primaryKey(),
    propertyId: text("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    localPath: text("local_path").notNull(),
    contentHash: text("content_hash"),
    ordinal: integer("ordinal").notNull(),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("uq_images_property_source").on(t.propertyId, t.sourceUrl),
    index("idx_images_property").on(t.propertyId),
    index("idx_images_hash").on(t.contentHash),
  ],
);

export const imageTags = sqliteTable(
  "image_tags",
  {
    imageId: text("image_id")
      .primaryKey()
      .references(() => images.id, { onDelete: "cascade" }),
    roomType: text("room_type"),
    confidence: real("confidence"),
    taggedBy: text("tagged_by").default("claude-code"),
    taggedAt: text("tagged_at").notNull(),
    notes: text("notes"),
  },
  (t) => [index("idx_image_tags_room").on(t.roomType)],
);

export const similarityGroups = sqliteTable("similarity_groups", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  roomType: text("room_type"),
  createdAt: text("created_at").notNull(),
  createdBy: text("created_by").default("claude-code"),
  notes: text("notes"),
});

export const similarityGroupMembers = sqliteTable(
  "similarity_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => similarityGroups.id, { onDelete: "cascade" }),
    imageId: text("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.imageId] }),
    index("idx_group_members_group").on(t.groupId),
    index("idx_group_members_image").on(t.imageId),
  ],
);

export const scrapeJobs = sqliteTable("scrape_jobs", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  status: text("status").notNull(), // queued | running | done | error
  propertyId: text("property_id").references(() => properties.id),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
export type Image = typeof images.$inferSelect;
export type ImageTag = typeof imageTags.$inferSelect;
export type SimilarityGroup = typeof similarityGroups.$inferSelect;
export type ScrapeJob = typeof scrapeJobs.$inferSelect;
