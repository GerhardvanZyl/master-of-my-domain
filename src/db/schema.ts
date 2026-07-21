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
  // Enrichment captured while browsing (not from the raw listing feed).
  nearestStation: text("nearest_station"),
  stationDistanceM: integer("station_distance_m"),
  secondStation: text("second_station"),
  secondStationDistanceM: integer("second_station_distance_m"),
  ptMinutesToFlinders: integer("pt_minutes_to_flinders"),
  ptRouteSummary: text("pt_route_summary"),
  ptSteps: text("pt_steps"),
  // Advertised price movement for the CURRENT for-sale campaign (Domain's
  // "shortlist price change") — e.g. previous "$890k–$930k" 2 months ago,
  // current "$850k–$880k". previous/label null when the price hasn't changed.
  advPriceCurrent: text("adv_price_current"),
  advPricePrevious: text("adv_price_previous"),
  advPricePreviousLabel: text("adv_price_previous_label"),
  // Neighbourhood metadata computed from lat/lng (straight-line) + OpenStreetMap.
  greenCrossDistanceM: integer("green_cross_distance_m"),
  colesDistanceM: integer("coles_distance_m"),
  colesName: text("coles_name"),
  playgrounds500m: integer("playgrounds_500m"),
  // My notes captured from Domain, and Claude's own short take on the property.
  domainNotes: text("domain_notes"),
  aiComment: text("ai_comment"),
  // Deduced-from-photos / calculated attributes (all correctable in-app).
  hasEaves: integer("has_eaves"), // 1 = all-around eaves, 0 = not, null = unknown
  altitudeM: real("altitude_m"),
  floodOverlay: integer("flood_overlay"), // 1/0/null
  bushfireOverlay: integer("bushfire_overlay"), // 1/0/null
  masterBedSqm: real("master_bed_sqm"),
  avgOtherBedSqm: real("avg_other_bed_sqm"),
  commonAreasCount: integer("common_areas_count"), // living+dining+rumpus+family+study
  balconySqm: real("balcony_sqm"),
  backGardenSqm: real("back_garden_sqm"),
  pergolaCovered: integer("pergola_covered"), // covered pergola/veranda/deck 1/0/null
  hasLawn: integer("has_lawn"), // 1/0/null
  lawnType: text("lawn_type"), // "real" | "fake" | null
  // Shortlist triage + free-text pros/cons. ponytail: pros/cons are one TEXT
  // column each, newline-separated — a list this small doesn't need a table.
  shortlistTag: text("shortlist_tag"), // must-see | maybe | rejected | null
  pros: text("pros"),
  cons: text("cons"),
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

/**
 * Vibe ratings, one row per (property, profile). Both Gerhard's and Johanita's
 * rows count toward a property's vibe score (see src/lib/vibes.ts), so a mutual
 * "meh" deducts twice. Profiles themselves live only in localStorage.
 */
export const propertyRatings = sqliteTable(
  "property_ratings",
  {
    propertyId: text("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    profile: text("profile").notNull(), // "gerhard" | "johanita"
    vibe: text("vibe"), // like | meh | dislike | hate | null
    look: text("look"), // good | ugly | null
    kitchen: text("kitchen"), // small | tiny | null
    score: real("score"), // your own 0–10 gut score
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.profile] })],
);

export const priceHistory = sqliteTable(
  "price_history",
  {
    id: text("id").primaryKey(),
    propertyId: text("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    // Free-text date as shown on Domain (e.g. "May 2021", "2019").
    date: text("date"),
    // Free-text event label from the listing history (e.g. "Sold", "Listed").
    event: text("event"),
    priceDisplay: text("price_display"),
    priceNumeric: integer("price_numeric"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_price_history_property").on(t.propertyId)],
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
export type PropertyRating = typeof propertyRatings.$inferSelect;
export type ScrapeJob = typeof scrapeJobs.$inferSelect;
export type PriceHistory = typeof priceHistory.$inferSelect;
export type NewPriceHistory = typeof priceHistory.$inferInsert;
