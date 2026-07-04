import type { SourceSite } from "@/db/schema";

export interface NormalizedImage {
  sourceUrl: string;
  ordinal: number;
}

export interface NormalizedProperty {
  sourceSite: SourceSite;
  listingUrl: string;
  externalId?: string | null;
  address?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  priceDisplay?: string | null;
  priceNumeric?: number | null;
  beds?: number | null;
  baths?: number | null;
  parking?: number | null;
  landSizeSqm?: number | null;
  propertyType?: string | null;
  agentName?: string | null;
  agencyName?: string | null;
  description?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Structured subset of the source's embedded JSON, stored as raw_json. */
  raw?: unknown;
  /** 'ok' | 'partial' — 'partial' means we got some data but not the full shape. */
  status?: "ok" | "partial";
}

export interface ExtractResult {
  property: NormalizedProperty;
  images: NormalizedImage[];
}
