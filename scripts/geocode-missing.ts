/**
 * geocode-missing.ts — geocode properties with no latitude via OSM Nominatim.
 *
 * realestate.com.au listing pages carry no coordinates (Domain supplies them
 * in JSON-LD `geo`, which is why every existing row has them). Without one,
 * REA properties get no map pin and are silently dropped by
 * compute-metadata.ts / compute-stations.ts, which both select
 * `WHERE latitude IS NOT NULL`.
 *
 * Run: npx tsx scripts/geocode-missing.ts
 * Reads: PROPS_JSON (a harvest file) if set, else the local DB.
 * Writes: data/harvest/geocode.json (override via OUT_JSON) — a
 *   `POST /api/batch` body, `{ properties: [{ listingUrl, latitude, longitude }] }`.
 *   Never writes data/app.db or data/images.
 *
 * Nominatim usage policy (hard rule, not a tuning knob): at most 1 request per
 * second, and a genuine identifying User-Agent. Node's fetch is unreliable
 * against OSM-adjacent endpoints from this machine (see
 * .claude/agent-memory/sidekick/node_fetch_overpass_blocked.md), so this
 * shells out to curl, following the pattern in scripts/lib/overpass-poi.ts.
 */
import "../src/lib/load-env";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sqlite } from "../src/db/client";

export type RawRow = {
  listingUrl: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
};

export type NominatimResult = {
  place_id?: number;
  lat: string;
  lon: string;
  display_name?: string;
  class?: string;
  type?: string;
  addresstype?: string;
  place_rank?: number;
  importance?: number;
};

export type Coordinate = { lat: number; lng: number };

export type CacheEntry =
  | { fetchedAt: string; hit: true; lat: number; lng: number }
  | { fetchedAt: string; hit: false };

export type CacheFile = Record<string, CacheEntry>;

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "master-of-my-domain-property-compare/1.0 (personal use)";
const NOMINATIM_DELAY_MS = 1100; // > 1 req/s per Nominatim's usage policy — not a tuning knob
const RETRY_BACKOFF_MS = [3000, 8000]; // transient-only: connection blips, not policy retries

export const DEFAULT_CACHE_PATH = resolve(process.cwd(), "data/harvest/geocode-cache.json");

// --- pure pieces: no network, no fs, fully testable ---

/** A row needs geocoding iff it has no latitude yet. Mirrors compute-metadata.ts's
 * `WHERE latitude IS NOT NULL`, inverted. */
export function needsGeocode(row: Pick<RawRow, "latitude">): boolean {
  return row.latitude == null;
}

/**
 * Builds the Nominatim query string, or null if the row has too little
 * address to geocode confidently. Address and suburb are the minimum: a
 * suburb-only or address-only query is exactly the ambiguous case the
 * confidence gate exists to catch, so there is no point sending it.
 */
export function buildQueryAddress(row: Pick<RawRow, "address" | "suburb" | "state" | "postcode">): string | null {
  const address = row.address?.trim();
  const suburb = row.suburb?.trim();
  if (!address || !suburb) return null;
  const parts = [address, suburb, row.state?.trim(), row.postcode?.trim(), "Australia"].filter(
    (p): p is string => !!p,
  );
  return parts.join(", ");
}

/** Cache key: normalised (trimmed, lower-cased, whitespace-collapsed) query address. */
export function normaliseAddress(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Confidence gate. Nominatim will happily return a suburb centroid when the
 * street address doesn't match — the dangerous case, since every downstream
 * distance/nearest-station/travel-time figure would be quietly wrong with
 * nothing about the row looking suspicious.
 *
 * place_rank 30 is Nominatim's finest search-result granularity (individual
 * building/address point). Ten live requests against real addresses (eight
 * of this DB's own Point Cook/Williams Landing rows, which already carry
 * Domain-supplied coordinates, plus two REA listings) all returned
 * `place_rank: 30, type: "house", addresstype: "place", class: "place"`
 * together — `addresstype: "place"` was never seen without `type: "house"`,
 * so gating on `addresstype` alone is not evidenced and is dropped. Gate on
 * rank 30 AND `type === "house"` so a future rank-30 result of an unfamiliar
 * kind doesn't slip through just because the rank matched.
 */
export function isHouseLevelMatch(result: NominatimResult): boolean {
  return result.place_rank === 30 && result.type === "house";
}

/** Parses a Nominatim `search` response (top hit only, since we request limit=1)
 * into a coordinate, or null if empty, malformed, or below the confidence gate. */
export function extractCoordinate(results: NominatimResult[]): Coordinate | null {
  const top = results[0];
  if (!top || !isHouseLevelMatch(top)) return null;
  // Nominatim's documented shape has lat/lon as strings. Reject anything else
  // before coercion: Number(true) is 1 and Number(["-37.9"]) is -37.9, so a
  // boolean or single-element array would otherwise coerce to a
  // finite-and-in-range number and slip past the checks below.
  if (typeof top.lat !== "string" || typeof top.lon !== "string") return null;
  const lat = Number(top.lat);
  const lng = Number(top.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Range, not just finiteness: a malformed response can still be finite but
  // physically impossible (e.g. lat: "999"). Reject rather than clamp — a
  // clamped coordinate is a plausible-looking wrong answer, which is exactly
  // what the confidence gate above exists to prevent.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Outcome of one row's live-fetch attempt, after retries. `resolved` covers
 * both a coordinate and a genuine low-confidence rejection (`coord: null`) —
 * both are Nominatim actually answering. `transient-error` is retries being
 * exhausted with no answer at all (network down, curl missing, timeout,
 * malformed JSON) and must never be confused with a rejection.
 */
export type FetchOutcome =
  | { kind: "resolved"; coord: Coordinate | null }
  | { kind: "transient-error"; message: string };

/**
 * Decides what, if anything, gets written to the cache for a row. A genuine
 * rejection (or hit) is cacheable — Nominatim answered, so the answer is
 * reusable. A transient error is NOT cacheable: writing `{ hit: false }` here
 * would make the row a permanent miss, since the cache is consulted before
 * requesting and there is no separate "retry me" state. Returning null
 * leaves the row with no cache entry, so it is retried on the next run.
 */
export function toCacheEntry(outcome: FetchOutcome): CacheEntry | null {
  if (outcome.kind === "transient-error") return null;
  return outcome.coord
    ? { fetchedAt: new Date().toISOString(), hit: true, lat: outcome.coord.lat, lng: outcome.coord.lng }
    : { fetchedAt: new Date().toISOString(), hit: false };
}

// --- impure pieces: curl + rate limiting, kept behind the pure ones above ---

export function loadCache(cachePath: string): CacheFile {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

export function saveCache(cachePath: string, cache: CacheFile) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

const execFileAsync = promisify(execFile);

async function fetchNominatim(query: string): Promise<NominatimResult[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const result = await execFileAsync(
        "curl",
        [
          "-sS",
          "-f",
          "--max-time",
          "30",
          "-A",
          USER_AGENT,
          "--get",
          NOMINATIM_URL,
          "--data-urlencode",
          `q=${query}`,
          "--data-urlencode",
          "format=json",
          "--data-urlencode",
          "limit=1",
          "--data-urlencode",
          "countrycodes=au",
        ],
        { maxBuffer: 1024 * 1024 * 8 },
      );
      return JSON.parse(result.stdout) as NominatimResult[];
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_BACKOFF_MS.length) {
        console.log(
          `    (Nominatim request failed, retrying in ${RETRY_BACKOFF_MS[attempt] / 1000}s: ${
            err instanceof Error ? err.message.split("\n")[0] : String(err)
          })`,
        );
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
      }
    }
  }
  throw new Error(
    `Nominatim request failed (curl) after ${RETRY_BACKOFF_MS.length + 1} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function main() {
  // PROPS_JSON lets this run against a harvest file instead of the DB, for
  // properties that live only on the live app (all writes go over HTTP) and
  // were never loaded locally. Same row shape either way. Unlike
  // compute-metadata.ts's `.filter(latitude != null)`, we want the inverse:
  // rows that still need coordinates.
  const src = process.env.PROPS_JSON;
  const allRows = (
    src
      ? (JSON.parse(readFileSync(src, "utf8")) as RawRow[])
      : (sqlite
          .prepare("SELECT listing_url AS listingUrl, address, suburb, state, postcode, latitude FROM properties")
          .all() as RawRow[])
  ) as RawRow[];
  const rows = allRows.filter(needsGeocode);
  console.log(
    `${allRows.length} properties total, ${rows.length} missing coordinates${src ? ` (from ${src})` : ""}.`,
  );

  const cachePath = DEFAULT_CACHE_PATH;
  const cache = loadCache(cachePath);

  const outProperties: { listingUrl: string; latitude: number; longitude: number }[] = [];
  const misses: string[] = [];
  const errors: string[] = [];
  const skippedNoAddress: string[] = [];
  let cacheHits = 0;
  let liveRequests = 0;

  for (const row of rows) {
    const query = buildQueryAddress(row);
    if (!query) {
      skippedNoAddress.push(row.listingUrl);
      continue;
    }
    const key = normaliseAddress(query);
    let entry = cache[key];
    if (entry) {
      cacheHits++;
    } else {
      liveRequests++;
      console.log(`  geocoding: ${query}`);
      let outcome: FetchOutcome;
      try {
        const results = await fetchNominatim(query);
        outcome = { kind: "resolved", coord: extractCoordinate(results) };
      } catch (err) {
        outcome = { kind: "transient-error", message: err instanceof Error ? err.message : String(err) };
      }
      const newEntry = toCacheEntry(outcome);
      if (newEntry) {
        cache[key] = newEntry;
        saveCache(cachePath, cache); // persist incrementally so a partial run resumes
      }
      await new Promise((r) => setTimeout(r, NOMINATIM_DELAY_MS));

      if (outcome.kind === "transient-error") {
        console.error(
          `    request failed after retries, NOT cached — eligible for retry next run: ${outcome.message}`,
        );
        errors.push(`${row.listingUrl} — ${query} — ${outcome.message}`);
        continue;
      }
      entry = newEntry!;
    }

    if (entry.hit) {
      outProperties.push({ listingUrl: row.listingUrl, latitude: entry.lat, longitude: entry.lng });
    } else {
      misses.push(`${row.listingUrl} — ${query}`);
    }
  }

  const outPath = resolve(process.cwd(), process.env.OUT_JSON ?? "data/harvest/geocode.json");
  writeFileSync(outPath, JSON.stringify({ properties: outProperties }, null, 2));

  console.log(`\nRows considered: ${rows.length}`);
  console.log(`Hits: ${outProperties.length}`);
  console.log(`Cache hits: ${cacheHits}`);
  console.log(`Skipped (no usable address): ${skippedNoAddress.length}`);
  console.log(`Misses — genuine low-confidence rejections, cached (${misses.length}):`);
  for (const m of misses) console.log(`  ${m}`);
  console.log(`Errors — transient failures, NOT cached, retry next run (${errors.length}):`);
  for (const e of errors) console.log(`  ${e}`);
  console.log(`\nWrote ${outProperties.length} coordinates -> ${outPath}`);
  if (errors.length > 0) {
    console.error(
      `\n${errors.length} row(s) failed transiently and were not cached — rerun this script to retry them.`,
    );
  }
}

// Only run when this file is the entrypoint — lets tests import the pure
// pieces above without triggering a live run.
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
