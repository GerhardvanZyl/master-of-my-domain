/**
 * Offline tests for scripts/geocode-missing.ts's pure pieces. No network: the
 * curl call is exercised nowhere here, only response parsing, the confidence
 * gate, address building, skip rules, and cache round-tripping.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildQueryAddress,
  extractCoordinate,
  isHouseLevelMatch,
  loadCache,
  needsGeocode,
  normaliseAddress,
  saveCache,
  toCacheEntry,
  type CacheFile,
  type NominatimResult,
  type RawRow,
} from "../scripts/geocode-missing";

// --- real Nominatim response shapes. Ten live requests were made against
// real addresses (eight sampled from the DB's own rows, which already carry
// Domain-supplied coordinates, plus two REA listings) — see
// .claude/review/runs/2026-08-31-rea-geocode-lite/brief.md. All ten house-level
// hits returned place_rank 30 / type "house" / addresstype "place" / class
// "place" together; a unit-style address returned the road shape below. ---

const HOUSE_TYPE_RESULT: NominatimResult = {
  place_id: 123456,
  lat: "-37.8874392",
  lon: "144.7106894",
  display_name: "46, Astoria Drive, Point Cook, Wyndham City Council, Victoria, 3030, Australia",
  class: "place",
  type: "house",
  addresstype: "place",
  place_rank: 30,
  importance: 0.42,
};

// The genuine reject case for a unit-style address (`2/15 Dunnings Road,
// Point Cook`): Nominatim returns the road, not a house, at a coarser rank.
const ROAD_RESULT: NominatimResult = {
  place_id: 111222,
  lat: "-37.8901234",
  lon: "144.7123456",
  display_name: "Dunnings Road, Point Cook, Wyndham City Council, Victoria, 3030, Australia",
  class: "highway",
  type: "secondary",
  addresstype: "road",
  place_rank: 26,
  importance: 0.3,
};

// Synthetic, NOT observed: exercises the boundary the gate must reject —
// place_rank 30 + addresstype "place" WITHOUT type "house". This is the
// unevidenced shape a previous version of the gate accepted via an invented
// OR branch; Nominatim's "place" class covers more than houses (farms,
// isolated dwellings, localities), so this must stay rejected.
const PLACE_CLASS_NON_HOUSE_RESULT: NominatimResult = {
  place_id: 333444,
  lat: "-37.8555555",
  lon: "144.6999999",
  display_name: "Somewhere Farm, Point Cook, Wyndham City Council, Victoria, 3030, Australia",
  class: "place",
  type: "farm",
  addresstype: "place",
  place_rank: 30,
  importance: 0.2,
};

const SUBURB_CENTROID_RESULT: NominatimResult = {
  place_id: 999999,
  lat: "-37.9000000",
  lon: "144.7000000",
  display_name: "Point Cook, Wyndham City Council, Victoria, Australia",
  class: "boundary",
  type: "administrative",
  addresstype: "suburb",
  place_rank: 16,
  importance: 0.5,
};

// --- confidence gate: the most important test in this file. A suburb
// centroid must never be treated as a confident match — every downstream
// distance/nearest-station figure would be silently wrong. ---

assert.equal(isHouseLevelMatch(HOUSE_TYPE_RESULT), true, "rank 30 + type=house is accepted");
assert.equal(isHouseLevelMatch(ROAD_RESULT), false, "the genuine road shape (rank 26, type=secondary) is rejected");
assert.equal(isHouseLevelMatch(SUBURB_CENTROID_RESULT), false, "a suburb centroid (rank 16) is rejected");
assert.equal(
  isHouseLevelMatch(PLACE_CLASS_NON_HOUSE_RESULT),
  false,
  "rank 30 + addresstype=place WITHOUT type=house is rejected — the dropped, unevidenced OR branch",
);

// A rank-30 result of an unfamiliar type is rejected too — rank alone is not
// sufficient, only rank plus the evidenced type.
assert.equal(
  isHouseLevelMatch({ ...SUBURB_CENTROID_RESULT, place_rank: 30, type: "shop", addresstype: "amenity" }),
  false,
  "rank 30 with an unfamiliar type is still rejected",
);

// --- parsing a real Nominatim response into a coordinate ---

assert.deepEqual(
  extractCoordinate([HOUSE_TYPE_RESULT]),
  { lat: -37.8874392, lng: 144.7106894 },
  "parses lat/lon strings into numbers",
);
assert.equal(extractCoordinate([SUBURB_CENTROID_RESULT]), null, "low-confidence top hit yields no coordinate");
assert.equal(extractCoordinate([]), null, "empty results (no match at all) yields no coordinate");
assert.equal(
  extractCoordinate([{ ...HOUSE_TYPE_RESULT, lat: "not-a-number" }]),
  null,
  "malformed lat/lon is never emitted as a coordinate",
);

// --- range and type checks: a finite-but-impossible or wrongly-typed
// lat/lon must never pass the gate, even when place_rank/type pass. ---

assert.equal(
  extractCoordinate([{ ...HOUSE_TYPE_RESULT, lat: "999" }]),
  null,
  "an out-of-range latitude (999) is rejected",
);
assert.equal(
  extractCoordinate([{ ...HOUSE_TYPE_RESULT, lon: "999" }]),
  null,
  "an out-of-range longitude (999) is rejected",
);
assert.equal(
  // @ts-expect-error — exercising a malformed response shape, not the declared type
  extractCoordinate([{ ...HOUSE_TYPE_RESULT, lat: true }]),
  null,
  "a boolean lat is rejected rather than coerced (Number(true) === 1, a finite in-range value)",
);
assert.equal(
  // @ts-expect-error — exercising a malformed response shape, not the declared type
  extractCoordinate([{ ...HOUSE_TYPE_RESULT, lat: ["-37.9"] }]),
  null,
  "an array lat is rejected rather than coerced (Number(['-37.9']) === -37.9, a finite in-range value)",
);

// --- skip rules ---

const existingCoordRow: Pick<RawRow, "latitude"> = { latitude: -37.8 };
const missingCoordRow: Pick<RawRow, "latitude"> = { latitude: null };
assert.equal(needsGeocode(existingCoordRow), false, "a row that already has coordinates is skipped");
assert.equal(needsGeocode(missingCoordRow), true, "a row with no latitude needs geocoding");

const goodAddressRow = { address: "46 Astoria Drive", suburb: "Point Cook", state: "VIC", postcode: "3030" };
assert.equal(
  buildQueryAddress(goodAddressRow),
  "46 Astoria Drive, Point Cook, VIC, 3030, Australia",
  "builds a full query string from address/suburb/state/postcode",
);

const noAddressRow = { address: null, suburb: "Point Cook", state: "VIC", postcode: "3030" };
assert.equal(buildQueryAddress(noAddressRow), null, "a row with no street address is skipped, not geocoded");

const noSuburbRow = { address: "46 Astoria Drive", suburb: null, state: "VIC", postcode: "3030" };
assert.equal(buildQueryAddress(noSuburbRow), null, "a row with no suburb is skipped, not geocoded");

// --- normalisation for cache keys ---

assert.equal(
  normaliseAddress("  46  Astoria Drive, Point Cook, VIC "),
  "46 astoria drive, point cook, vic",
  "cache key collapses whitespace and case",
);

// --- cache round-trip, including that a cached miss is not re-requested ---

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-geocode-cache-"));
const cachePath = path.join(tmpDir, "geocode-cache.json");

assert.deepEqual(loadCache(cachePath), {}, "a missing cache file loads as empty, not an error");

const cache: CacheFile = {
  "46 astoria drive, point cook, vic, 3030, australia": {
    fetchedAt: "2026-08-31T00:00:00.000Z",
    hit: true,
    lat: -37.8874392,
    lng: 144.7106894,
  },
  "1 nowhere lane, nowhereville, vic, 9999, australia": {
    fetchedAt: "2026-08-31T00:00:00.000Z",
    hit: false,
  },
};
saveCache(cachePath, cache);
const reloaded = loadCache(cachePath);
assert.deepEqual(reloaded, cache, "cache round-trips through disk unchanged");
assert.equal(
  reloaded["1 nowhere lane, nowhereville, vic, 9999, australia"].hit,
  false,
  "a cached miss is preserved as a miss, not re-requested on the next run",
);

fs.rmSync(tmpDir, { recursive: true, force: true });

// --- an emitted payload never contains a null latitude/longitude ---
// Mirrors main()'s assembly: only rows where extractCoordinate() returned a
// coordinate are ever pushed onto the output array.
const rawResults: (NominatimResult[] | [])[] = [[HOUSE_TYPE_RESULT], [SUBURB_CENTROID_RESULT], [], [ROAD_RESULT]];
const emitted = rawResults
  .map((results) => extractCoordinate(results))
  .filter((c): c is { lat: number; lng: number } => c != null)
  .map((c) => ({ listingUrl: "irrelevant", latitude: c.lat, longitude: c.lng }));
assert.equal(emitted.length, 1, "only the one house-level result is emitted");
for (const row of emitted) {
  assert.notEqual(row.latitude, null, "emitted row never has a null latitude");
  assert.notEqual(row.longitude, null, "emitted row never has a null longitude");
}

// --- transient failures vs genuine misses: the cache decision itself ---
// This is the seam main()'s row loop delegates to. Proving it here proves the
// loop can't cache a transient failure, without needing to mock curl.

assert.equal(
  toCacheEntry({ kind: "transient-error", message: "curl: (7) Failed to connect" }),
  null,
  "a transient failure produces no cache entry at all — not even a placeholder",
);

const rejectionEntry = toCacheEntry({ kind: "resolved", coord: null });
assert.equal(rejectionEntry?.hit, false, "a genuine low-confidence rejection IS cacheable, as a miss");

const hitEntry = toCacheEntry({ kind: "resolved", coord: { lat: -37.88, lng: 144.71 } });
assert.equal(hitEntry?.hit, true, "a resolved coordinate is cacheable, as a hit");
if (hitEntry?.hit) {
  assert.equal(hitEntry.lat, -37.88);
  assert.equal(hitEntry.lng, 144.71);
}

// A transient failure must leave the row eligible for retry: since
// toCacheEntry returns null, main() never calls cache[key] = ..., so the key
// stays absent from the cache file and the next run treats it as new.
const retryTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-geocode-retry-"));
const retryCachePath = path.join(retryTmpDir, "geocode-cache.json");
const retryCache: CacheFile = {};
const failureEntry = toCacheEntry({ kind: "transient-error", message: "timed out" });
if (failureEntry) retryCache["some address, australia"] = failureEntry; // mirrors main()'s `if (newEntry)` guard
saveCache(retryCachePath, retryCache);
assert.deepEqual(
  loadCache(retryCachePath),
  {},
  "after a transient failure, the row's key is absent from the persisted cache — eligible for retry",
);
fs.rmSync(retryTmpDir, { recursive: true, force: true });

console.log("geocode-missing.test.ts OK");
