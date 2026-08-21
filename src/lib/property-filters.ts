import type { PropertyListItem } from "@/db/queries/properties";

/**
 * The properties-grid filter set — the fields that decide which properties are
 * INCLUDED, shared by PropertyGrid (the only writer) and MapView (a reader).
 * One definition here means a new filter added to the grid can't silently be
 * missing from the map, or vice versa.
 *
 * Deliberately excludes `sort` and `idealPrice`: neither one removes a
 * property from the set (sort only reorders; idealPrice only feeds the vibe
 * score), so they don't belong to "the filter set" the map needs — same
 * reasoning the grid already applies to mapSize/layout/pinned as presentation
 * state, just for a different pair of fields. They stay local `useState` in
 * PropertyGrid, same as before this change.
 */
export interface FilterState {
  suburb: string[];
  minBeds: number;
  minBaths: number;
  minParking: number;
  maxPrice: number;
  q: string;
  tagFilter: string;
  hideAuction: boolean;
  hideUnderOffer: boolean;
  hideDelisted: boolean;
  inspectingFilter: string;
  attendedFilter: string;
  viewedFilter: string;
  ratedFilter: string;
  newFilter: string;
}

// Slider top = "no cap". Kept here (not just in PropertyGrid) because
// filterProperties needs the same "at max means uncapped" reading.
export const PRICE_MAX = 1_500_000;

export const DEFAULT_FILTER_STATE: FilterState = {
  suburb: [],
  minBeds: 0,
  minBaths: 0,
  minParking: 0,
  maxPrice: PRICE_MAX,
  q: "",
  tagFilter: "",
  hideAuction: false,
  hideUnderOffer: false,
  hideDelisted: false,
  inspectingFilter: "off",
  attendedFilter: "off",
  viewedFilter: "off",
  ratedFilter: "off",
  newFilter: "off",
};

// "New" badge / filter window.
export const NEW_FOR_MS = 7 * 86400_000;

/* --- Tri-state filter chips -------------------------------------------------
   "off" (no fill) → "in" (green: only properties with this) → "ex" (amber:
   hide properties with this) → "off".
   ponytail: plain strings, no enum/union type — they never leave this module
   and `asTri` is the only thing that has to be careful. Older saved values
   from before the rework fall back to "off" rather than being migrated. */
const asTri = (v: unknown): string => (v === "in" || v === "ex" ? v : "off");

/** Keeps a property when the chip is off, or when it matches the chip's side. */
const triKeep = (mode: string, has: boolean): boolean =>
  mode === "off" ? true : mode === "in" ? has : !has;

// Sale status is only in the free-text price_display (no dedicated column).
const isAuction = (p: PropertyListItem): boolean => /auction/i.test(p.priceDisplay ?? "");
const isUnderOffer = (p: PropertyListItem): boolean =>
  /under\s*offer|under\s*contract/i.test(p.priceDisplay ?? "");

/**
 * True if `iso` falls within the coming Sat 00:00 – Mon 00:00 window.
 * ponytail: plain local Date math, not Melbourne-TZ aware — good enough for a
 * "this weekend" filter chip; the app's users are all in Melbourne anyway.
 */
function isThisWeekend(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const day = now.getDay(); // 0 = Sun .. 6 = Sat
  const satOffset = day === 6 ? 0 : day === 0 ? -1 : 6 - day;
  const satStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + satOffset);
  const monStart = new Date(satStart.getFullYear(), satStart.getMonth(), satStart.getDate() + 2);
  return d >= satStart && d < monStart;
}

/**
 * "Rated" = the user has expressed ANY opinion, from EITHER profile: a
 * ratings row with a vibe/look/kitchen/score, or free-text pros/cons.
 *
 * `myVibeOverride` lets a caller with an in-flight optimistic edit (the grid's
 * emoji row writes to local state before the server round-trip lands) report
 * that edit instead of the last-saved row; omit it to read straight off
 * `ratings` — what MapView does, since it never edits anything.
 */
export function isRatedProperty(
  p: Pick<PropertyListItem, "pros" | "cons" | "ratings">,
  profile: string | null,
  myVibeOverride?: string | null,
): boolean {
  if ((p.pros ?? "").trim() || (p.cons ?? "").trim()) return true;
  const myVibe =
    myVibeOverride !== undefined ? myVibeOverride : (p.ratings.find((r) => r.profile === profile)?.vibe ?? null);
  if (myVibe) return true;
  return p.ratings.some((r) => (r.profile !== profile && r.vibe) || r.look || r.kitchen || r.score != null);
}

/**
 * Back-compat, field-by-field parse of a saved `filters:*` localStorage blob
 * into a well-formed FilterState — unknown/malformed/missing fields fall back
 * to the default rather than reaching the filter below as `undefined`/NaN.
 * Mirrors exactly what PropertyGrid's restore effect used to do inline.
 */
export function parseFilterState(raw: unknown): FilterState {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    // Back-compat: old saved value was a single suburb string.
    suburb: Array.isArray(s.suburb)
      ? (s.suburb as string[])
      : typeof s.suburb === "string" && s.suburb
        ? [s.suburb]
        : [],
    minBeds: typeof s.minBeds === "number" ? s.minBeds : 0,
    minBaths: typeof s.minBaths === "number" ? s.minBaths : 0,
    minParking: typeof s.minParking === "number" ? s.minParking : 0,
    maxPrice: typeof s.maxPrice === "number" ? s.maxPrice : PRICE_MAX,
    q: typeof s.q === "string" ? s.q : "",
    tagFilter: typeof s.tagFilter === "string" ? s.tagFilter : "",
    hideAuction: !!s.hideAuction,
    hideUnderOffer: !!s.hideUnderOffer,
    hideDelisted: !!s.hideDelisted,
    inspectingFilter: asTri(s.inspectingFilter),
    attendedFilter: asTri(s.attendedFilter),
    viewedFilter: asTri(s.viewedFilter),
    ratedFilter: asTri(s.ratedFilter),
    newFilter: /^[1-4]w$/.test(String(s.newFilter)) ? (s.newFilter as string) : "off",
  };
}

/**
 * The localStorage key PropertyGrid persists a region's filter/sort state
 * under: "" prefix for "vic" keeps the pre-existing key, other regions get a
 * name prefix (suburb lists are disjoint per region), bucketed per profile
 * ("default" when none). MapView reads under the SAME key to apply the
 * grid's filters to its pins — kept here, next to parseFilterState, so the
 * key format has one definition instead of being hand-copied into MapView.
 */
export function filterKey(region: string, profile: string | null): string {
  return `filters:${region === "vic" ? "" : region + ":"}${profile ?? "default"}`;
}

/**
 * Restore a region's saved FilterState from localStorage — the read side of
 * `filterKey`. Used by MapView, which only ever reads (there's no filter UI
 * on that page); PropertyGrid still owns writing under this key.
 */
export function loadRegionFilters(region: string, profile: string | null): FilterState {
  let raw: unknown = {};
  try {
    raw = JSON.parse(localStorage.getItem(filterKey(region, profile)) || "{}");
  } catch {
    /* ignore */
  }
  return parseFilterState(raw);
}

/** Accessors the predicate needs but can't compute on its own — a property's
 *  "attended"/"shortlist" value may be overlaid with an unsaved local edit
 *  (PropertyGrid) or read straight off the server row (MapView, which never
 *  edits). `isRated` is passed in rather than reconstructed here because it
 *  also needs `profile`, which the predicate itself has no reason to know. */
export interface FilterCtx {
  shortlistOf: (p: PropertyListItem) => string | null;
  attendedOf: (p: PropertyListItem) => string | null;
  viewedSet: Set<string>;
  isRated: (p: PropertyListItem) => boolean;
}

/**
 * The one definition of "which properties does this filter selection keep",
 * used by both PropertyGrid's grid and MapView's pins. Order of checks
 * mirrors the original inline version in PropertyGrid for easy diffing.
 */
export function filterProperties(
  properties: PropertyListItem[],
  state: FilterState,
  ctx: FilterCtx,
): PropertyListItem[] {
  const maxP = state.maxPrice >= PRICE_MAX ? null : state.maxPrice;
  const needle = state.q.trim().toLowerCase();
  // Suburb membership is checked per property — a Set beats Array.includes
  // once you've ticked more than a couple of suburbs.
  const subs = state.suburb.length ? new Set(state.suburb) : null;
  return properties.filter((p) => {
    if (state.tagFilter && ctx.shortlistOf(p) !== state.tagFilter) return false;
    if (subs && (!p.suburb || !subs.has(p.suburb))) return false;
    if (state.minBeds && (p.beds ?? 0) < state.minBeds) return false;
    if (state.minBaths && (p.baths ?? 0) < state.minBaths) return false;
    if (state.minParking && (p.parking ?? 0) < state.minParking) return false;
    if (maxP != null && (p.priceNumeric ?? Infinity) > maxP) return false;
    if (needle && !(p.address ?? "").toLowerCase().includes(needle)) return false;
    if (state.hideAuction && isAuction(p)) return false;
    if (state.hideUnderOffer && isUnderOffer(p)) return false;
    if (state.hideDelisted && p.delisted) return false;
    if (!triKeep(state.inspectingFilter, isThisWeekend(p.nextInspection))) return false;
    if (!triKeep(state.attendedFilter, !!ctx.attendedOf(p))) return false;
    if (!triKeep(state.viewedFilter, ctx.viewedSet.has(p.id))) return false;
    if (!triKeep(state.ratedFilter, ctx.isRated(p))) return false;
    if (state.newFilter !== "off") {
      const age = Date.now() - new Date(p.createdAt).getTime();
      if (age >= NEW_FOR_MS * parseInt(state.newFilter, 10)) return false;
    }
    return true;
  });
}
