/**
 * Unit tests for src/lib/property-filters.ts — the single definition of "which
 * properties does this filter selection keep", now shared by PropertyGrid and
 * MapView. Carries the most regression risk in this change, since a bug here
 * silently affects both consumers identically.
 */
import assert from "node:assert/strict";
import type { PropertyListItem } from "../src/db/queries/properties";
import {
  DEFAULT_FILTER_STATE,
  filterProperties,
  parseFilterState,
  type FilterCtx,
  type FilterState,
} from "../src/lib/property-filters";

// Minimal-but-complete PropertyListItem factory. Only the fields the
// predicate (or its test scenarios) actually touch vary per call; everything
// else defaults to an inert value so every test object type-checks fully
// against PropertyListItem rather than being cast away.
let seq = 0;
function mkProp(overrides: Partial<PropertyListItem> = {}): PropertyListItem {
  seq += 1;
  return {
    id: `p${seq}`,
    sourceSite: "domain",
    listingUrl: `https://example.com/p${seq}`,
    externalId: null,
    address: `${seq} Test St`,
    suburb: "Point Cook",
    state: null,
    postcode: null,
    priceDisplay: null,
    priceNumeric: 800_000,
    beds: 3,
    baths: 2,
    parking: 1,
    landSizeSqm: null,
    propertyType: null,
    agentName: null,
    agencyName: null,
    latitude: null,
    longitude: null,
    nearestStation: null,
    stationDistanceM: null,
    secondStation: null,
    secondStationDistanceM: null,
    ptMinutesToFlinders: null,
    ptRouteSummary: null,
    ptSteps: null,
    advPriceCurrent: null,
    advPricePrevious: null,
    advPricePreviousLabel: null,
    nextInspection: null,
    attendedAt: null,
    greenCrossDistanceM: null,
    colesDistanceM: null,
    colesName: null,
    playgrounds500m: null,
    domainNotes: null,
    aiComment: null,
    hasEaves: null,
    altitudeM: null,
    floodOverlay: null,
    bushfireOverlay: null,
    masterBedSqm: null,
    avgOtherBedSqm: null,
    commonAreasCount: null,
    balconySqm: null,
    backGardenSqm: null,
    pergolaCovered: null,
    hasLawn: null,
    lawnType: null,
    shortlistTag: null,
    pros: null,
    cons: null,
    propertyComAuUrl: null,
    yearBuilt: null,
    scrapedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scrapeStatus: "ok",
    scrapeError: null,
    imageCount: 0,
    thumbPath: null,
    delisted: false,
    saleStatus: null,
    lastPricedEvent: null,
    soldDate: null,
    ratings: [],
    ...overrides,
  };
}

function ids(props: PropertyListItem[]): string[] {
  return props.map((p) => p.id);
}

function ctx(overrides: Partial<FilterCtx> = {}): FilterCtx {
  return {
    shortlistOf: (p) => p.shortlistTag,
    attendedOf: (p) => p.attendedAt,
    viewedSet: new Set<string>(),
    isRated: () => false,
    ...overrides,
  };
}

// --- suburb (multi-select) --------------------------------------------------
{
  const a = mkProp({ suburb: "Point Cook" });
  const b = mkProp({ suburb: "Williams Landing" });
  const c = mkProp({ suburb: "Werribee" });
  const props = [a, b, c];
  assert.deepEqual(
    ids(filterProperties(props, { ...DEFAULT_FILTER_STATE, suburb: ["Point Cook", "Werribee"] }, ctx())),
    [a.id, c.id],
    "keeps properties in ANY of the selected suburbs",
  );
  assert.deepEqual(
    ids(filterProperties(props, DEFAULT_FILTER_STATE, ctx())),
    ids(props),
    "empty suburb selection keeps everything",
  );
  assert.deepEqual(
    ids(filterProperties([mkProp({ suburb: null })], { ...DEFAULT_FILTER_STATE, suburb: ["Point Cook"] }, ctx())),
    [],
    "a property with no suburb is dropped once a suburb filter is active",
  );
}

// --- minBeds / minBaths / minParking -----------------------------------------
{
  const props = [mkProp({ beds: 2, baths: 1, parking: 1 }), mkProp({ beds: 4, baths: 2, parking: 2 })];
  assert.equal(
    filterProperties(props, { ...DEFAULT_FILTER_STATE, minBeds: 3 }, ctx()).length,
    1,
    "minBeds excludes properties below the threshold",
  );
  assert.equal(
    filterProperties(props, { ...DEFAULT_FILTER_STATE, minBaths: 2 }, ctx()).length,
    1,
    "minBaths excludes properties below the threshold",
  );
  assert.equal(
    filterProperties(props, { ...DEFAULT_FILTER_STATE, minParking: 2 }, ctx()).length,
    1,
    "minParking excludes properties below the threshold",
  );
  assert.equal(
    filterProperties([mkProp({ beds: null })], { ...DEFAULT_FILTER_STATE, minBeds: 1 }, ctx()).length,
    0,
    "null beds treated as 0 against a positive threshold",
  );
}

// --- maxPrice (PRICE_MAX = uncapped) -----------------------------------------
{
  const cheap = mkProp({ priceNumeric: 700_000 });
  const expensive = mkProp({ priceNumeric: 2_000_000 });
  const unpriced = mkProp({ priceNumeric: null });
  const props = [cheap, expensive, unpriced];
  assert.deepEqual(
    ids(filterProperties(props, { ...DEFAULT_FILTER_STATE, maxPrice: 1_000_000 }, ctx())),
    [cheap.id],
    "maxPrice excludes pricier properties and unpriced ones (treated as Infinity)",
  );
  assert.deepEqual(
    ids(filterProperties(props, DEFAULT_FILTER_STATE, ctx())),
    ids(props),
    "maxPrice at the slider top (PRICE_MAX) means uncapped, including unpriced properties",
  );
}

// --- free-text q --------------------------------------------------------------
{
  const a = mkProp({ address: "20 Villiers Drive" });
  const b = mkProp({ address: "5 Example Court" });
  assert.deepEqual(
    ids(filterProperties([a, b], { ...DEFAULT_FILTER_STATE, q: "villiers" }, ctx())),
    [a.id],
    "q matches case-insensitively, substring of address",
  );
  assert.deepEqual(
    ids(filterProperties([a, mkProp({ address: null })], { ...DEFAULT_FILTER_STATE, q: "x" }, ctx())),
    [],
    "a null address never matches a non-empty query",
  );
}

// --- tagFilter (shortlist) ----------------------------------------------------
{
  const mustSee = mkProp({ shortlistTag: "must-see" });
  const maybe = mkProp({ shortlistTag: "maybe" });
  assert.deepEqual(
    ids(filterProperties([mustSee, maybe], { ...DEFAULT_FILTER_STATE, tagFilter: "must-see" }, ctx())),
    [mustSee.id],
  );
}

// --- hideAuction / hideUnderOffer / hideDelisted ------------------------------
{
  const auction = mkProp({ priceDisplay: "Auction Sat 12pm" });
  const underOffer = mkProp({ priceDisplay: "Under Offer" });
  const normal = mkProp({ priceDisplay: "$800,000" });
  const delisted = mkProp({ delisted: true });
  assert.deepEqual(
    ids(filterProperties([auction, normal], { ...DEFAULT_FILTER_STATE, hideAuction: true }, ctx())),
    [normal.id],
  );
  assert.deepEqual(
    ids(filterProperties([underOffer, normal], { ...DEFAULT_FILTER_STATE, hideUnderOffer: true }, ctx())),
    [normal.id],
  );
  assert.deepEqual(
    ids(filterProperties([delisted, normal], { ...DEFAULT_FILTER_STATE, hideDelisted: true }, ctx())),
    [normal.id],
  );
}

// --- tri-state chips: off / in / ex, each asserted, since off vs ex is where
// a tri-state bug hides (an inverted "ex" could silently behave like "in"). ---
{
  const attended = mkProp({ attendedAt: "2026-08-01" });
  const notAttended = mkProp({ attendedAt: null });
  const props = [attended, notAttended];

  assert.deepEqual(
    ids(filterProperties(props, { ...DEFAULT_FILTER_STATE, attendedFilter: "off" }, ctx())),
    ids(props),
    "off keeps everything regardless of the chip's dimension",
  );
  assert.deepEqual(
    ids(filterProperties(props, { ...DEFAULT_FILTER_STATE, attendedFilter: "in" }, ctx())),
    [attended.id],
    "in keeps ONLY properties matching the chip",
  );
  assert.deepEqual(
    ids(filterProperties(props, { ...DEFAULT_FILTER_STATE, attendedFilter: "ex" }, ctx())),
    [notAttended.id],
    "ex keeps ONLY properties NOT matching the chip — the opposite of in, not a no-op",
  );

  // ratedFilter and viewedFilter go through ctx rather than a direct column;
  // exercise their off/in/ex too since the wiring (not just triKeep) can drift.
  const rated = mkProp();
  const unrated = mkProp();
  const ratedCtx = ctx({ isRated: (p) => p.id === rated.id });
  assert.deepEqual(ids(filterProperties([rated, unrated], { ...DEFAULT_FILTER_STATE, ratedFilter: "in" }, ratedCtx)), [rated.id]);
  assert.deepEqual(ids(filterProperties([rated, unrated], { ...DEFAULT_FILTER_STATE, ratedFilter: "ex" }, ratedCtx)), [unrated.id]);

  const viewed = mkProp();
  const unviewed = mkProp();
  const viewedCtx = ctx({ viewedSet: new Set([viewed.id]) });
  assert.deepEqual(ids(filterProperties([viewed, unviewed], { ...DEFAULT_FILTER_STATE, viewedFilter: "in" }, viewedCtx)), [viewed.id]);
  assert.deepEqual(ids(filterProperties([viewed, unviewed], { ...DEFAULT_FILTER_STATE, viewedFilter: "ex" }, viewedCtx)), [unviewed.id]);

  // inspectingFilter (isThisWeekend) is never routed through filterProperties
  // anywhere else in this file — the only other mention is parseFilterState's
  // malformed-value fallback, which checks parsing, not filtering. Computed
  // relative to "now" the same way isThisWeekend itself does, so this passes
  // regardless of which day the suite runs on.
  const now = new Date();
  const day = now.getDay(); // 0 = Sun .. 6 = Sat
  const satOffset = day === 6 ? 0 : day === 0 ? -1 : 6 - day;
  const satStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + satOffset);
  const insideWeekend = new Date(
    satStart.getFullYear(),
    satStart.getMonth(),
    satStart.getDate(),
    10,
  ).toISOString();
  const outsideWeekend = new Date(
    satStart.getFullYear(),
    satStart.getMonth(),
    satStart.getDate() + 10,
  ).toISOString();
  const thisWeekend = mkProp({ nextInspection: insideWeekend });
  const notThisWeekend = mkProp({ nextInspection: outsideWeekend });
  const inspectingProps = [thisWeekend, notThisWeekend];
  assert.deepEqual(
    ids(filterProperties(inspectingProps, { ...DEFAULT_FILTER_STATE, inspectingFilter: "off" }, ctx())),
    ids(inspectingProps),
    "off keeps everything regardless of inspection timing",
  );
  assert.deepEqual(
    ids(filterProperties(inspectingProps, { ...DEFAULT_FILTER_STATE, inspectingFilter: "in" }, ctx())),
    [thisWeekend.id],
    "in keeps ONLY properties inspecting this weekend",
  );
  assert.deepEqual(
    ids(filterProperties(inspectingProps, { ...DEFAULT_FILTER_STATE, inspectingFilter: "ex" }, ctx())),
    [notThisWeekend.id],
    "ex keeps ONLY properties NOT inspecting this weekend — the opposite of in, not a no-op",
  );
}

// --- parseFilterState back-compat --------------------------------------------
{
  // Legacy shape: `suburb` was a single string, not an array.
  assert.deepEqual(
    parseFilterState({ suburb: "Point Cook" }).suburb,
    ["Point Cook"],
    "a legacy plain-string suburb still parses into a one-element array",
  );
  assert.deepEqual(parseFilterState({ suburb: "" }).suburb, [], "a legacy empty-string suburb parses to []");
  assert.deepEqual(parseFilterState({ suburb: ["A", "B"] }).suburb, ["A", "B"], "current array shape passes through");
  assert.deepEqual(parseFilterState(null).suburb, [], "null/missing raw input falls back to defaults");
  assert.deepEqual(parseFilterState({ suburb: "X" }), {
    ...DEFAULT_FILTER_STATE,
    suburb: ["X"],
  });
  assert.equal(parseFilterState({ inspectingFilter: "bogus" }).inspectingFilter, "off", "malformed tri-state chip falls back to off");
  assert.equal(parseFilterState({ maxPrice: "not-a-number" }).maxPrice, DEFAULT_FILTER_STATE.maxPrice);
}

console.log("✓ property-filters.test: all assertions passed");
