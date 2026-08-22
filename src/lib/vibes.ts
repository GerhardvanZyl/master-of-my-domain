import type { Property } from "@/db/schema";

/**
 * "Vibes" score — starts at cfg.baseScore and applies the deductions/bonuses the user
 * specified. Config values are stored as positive magnitudes; the sign is
 * applied here. Everything is configurable (persisted in localStorage by the
 * settings panel); DEFAULT_VIBE_CONFIG holds the user's original numbers.
 */
export interface VibeConfig {
  baseScore: number; // what every property starts on, before deductions/bonuses
  idealPrice: number;
  perStation250m: number; // −1 per 250 m from nearest station
  stationExponent: number; // 1 = linear; >1 punishes distance super-linearly
  perAbove5000: number; // −1 per $5k above ideal
  priceAboveExponent: number; // 1 = linear; >1 punishes overpaying super-linearly
  perBelow10000: number; // −1 per $10k below ideal
  priceBelowExponent: number; // 1 = linear; >1 punishes underpricing super-linearly
  perGreenCrossKm: number; // −1 per 1 km from Green Cross Vets
  greenCrossCapKm: number; // distance beyond this counts as this (default 20 km)
  perCon: number; // −3 per listed con
  noPlaygrounds: number; // −5 if no playground within 500 m
  perFlinders5min: number; // −3 per 5 min travel to Flinders St
  flindersExponent: number; // 1 = linear; >1 punishes long commutes super-linearly
  noEaves: number; // −5 if no all-around eaves
  noPergola: number; // −3 if no covered pergola/veranda/deck
  noLawn: number; // −10 if no lawn
  like: number; // +25
  meh: number; // −10
  dislike: number; // −25
  hate: number; // −50
  looksGood: number; // +10
  looksUgly: number; // −10
  smallKitchen: number; // −10
  tinyKitchen: number; // −50
  perLivingArea: number; // +5 per living area
  perBedBelow4: number; // −5 per bedroom under 4
  perMasterSqmBelow18: number; // −2 per sqm the master is under 18 m²
  perOtherBedSqmBelow11: number; // −2 per sqm the other beds average under 11 m²
}

export const DEFAULT_VIBE_CONFIG: VibeConfig = {
  baseScore: 1000,
  idealPrice: 850_000,
  perStation250m: 1,
  stationExponent: 1,
  perAbove5000: 1,
  priceAboveExponent: 1,
  perBelow10000: 1,
  priceBelowExponent: 1,
  perGreenCrossKm: 1,
  greenCrossCapKm: 20,
  perCon: 3,
  noPlaygrounds: 5,
  perFlinders5min: 3,
  flindersExponent: 1,
  noEaves: 5,
  noPergola: 3,
  noLawn: 10,
  like: 25,
  meh: 10,
  dislike: 25,
  hate: 50,
  looksGood: 10,
  looksUgly: 10,
  smallKitchen: 10,
  tinyKitchen: 50,
  perLivingArea: 5,
  perBedBelow4: 5,
  perMasterSqmBelow18: 2,
  perOtherBedSqmBelow11: 2,
};

export interface Rating {
  profile?: string | null; // whose reaction this is (labels the breakdown)
  vibe?: string | null; // like | meh | dislike | hate
  look?: string | null; // good | ugly
  kitchen?: string | null; // small | tiny
}

// Fields vibeScore reads — Property has them all, but keep it structural so
// the client PropertyListItem (with ratings attached) works too.
type Scorable = Pick<
  Property,
  | "priceNumeric"
  | "stationDistanceM"
  | "greenCrossDistanceM"
  | "playgrounds500m"
  | "ptMinutesToFlinders"
  | "hasEaves"
  | "pergolaCovered"
  | "hasLawn"
  | "beds"
  | "commonAreasCount"
  | "masterBedSqm"
  | "avgOtherBedSqm"
  | "cons"
>;

/**
 * units^k, the shape both distance penalties share. k = 1 is the original
 * linear rule; k > 1 makes far properties hurt disproportionately (retune the
 * per-unit weight down to compensate). A non-positive k is meaningless here —
 * 0 flattens the penalty to a constant and k < 0 returns Infinity at zero
 * distance, which would NaN the whole grid — so it is clamped, not trusted.
 */
const curve = (units: number, k: number) => Math.pow(units, Math.max(0.1, k));

export interface BreakdownRow {
  label: string;
  pts: number;
}

/** Every non-zero term that makes up the score, in the order it's applied. */
export function vibeBreakdown(
  p: Scorable,
  ratings: Rating[],
  cfg: VibeConfig = DEFAULT_VIBE_CONFIG,
): BreakdownRow[] {
  const rows: BreakdownRow[] = [{ label: "Base score", pts: cfg.baseScore }];
  const push = (label: string, pts: number) => {
    if (Math.abs(pts) >= 0.05) rows.push({ label, pts: Math.round(pts * 10) / 10 });
  };

  if (p.stationDistanceM != null)
    push(
      `Station ${p.stationDistanceM} m away`,
      -curve(p.stationDistanceM / 250, cfg.stationExponent) * cfg.perStation250m,
    );
  if (p.priceNumeric != null) {
    if (p.priceNumeric > cfg.idealPrice)
      push(
        "Above ideal price",
        -curve((p.priceNumeric - cfg.idealPrice) / 5000, cfg.priceAboveExponent) * cfg.perAbove5000,
      );
    else if (p.priceNumeric < cfg.idealPrice)
      push(
        "Below ideal price",
        -curve((cfg.idealPrice - p.priceNumeric) / 10000, cfg.priceBelowExponent) * cfg.perBelow10000,
      );
  }
  if (p.greenCrossDistanceM != null) {
    const km = Math.min(p.greenCrossDistanceM / 1000, cfg.greenCrossCapKm);
    push("Distance to Green Cross vet", -km * cfg.perGreenCrossKm);
  }
  if (!p.playgrounds500m) push("No playground ≤500 m", -cfg.noPlaygrounds);
  if (p.ptMinutesToFlinders != null)
    push(
      "Transit to Flinders St",
      -curve(p.ptMinutesToFlinders / 5, cfg.flindersExponent) * cfg.perFlinders5min,
    );
  // ponytail: only penalize a KNOWN-absent feature (0). null = not-yet-harvested,
  // so an un-inspected property isn't docked for missing data.
  if (p.hasEaves === 0) push("No all-around eaves", -cfg.noEaves);
  if (p.pergolaCovered === 0) push("No covered pergola", -cfg.noPergola);
  if (p.hasLawn === 0) push("No lawn", -cfg.noLawn);
  if (p.commonAreasCount)
    push(`${p.commonAreasCount} living areas`, p.commonAreasCount * cfg.perLivingArea);
  if (p.beds != null && p.beds < 4)
    push(`Only ${p.beds} bedrooms`, -(4 - p.beds) * cfg.perBedBelow4);
  if (p.masterBedSqm != null && p.masterBedSqm < 18)
    push(
      `Master bed ${p.masterBedSqm} m²`,
      -(18 - p.masterBedSqm) * cfg.perMasterSqmBelow18,
    );
  if (p.avgOtherBedSqm != null && p.avgOtherBedSqm < 11)
    push(
      `Other beds avg ${p.avgOtherBedSqm} m²`,
      -(11 - p.avgOtherBedSqm) * cfg.perOtherBedSqmBelow11,
    );
  // Free-text cons are one per line (see schema.ts) — each one costs points.
  const cons = (p.cons ?? "").split("\n").filter((l) => l.trim()).length;
  if (cons) push(`${cons} con${cons > 1 ? "s" : ""} listed`, -cons * cfg.perCon);
  // Ratings: both profiles' rows count, so a mutual "meh" deducts twice.
  for (const r of ratings) {
    const who = r.profile ? `${r.profile}: ` : "";
    if (r.vibe === "like") push(`${who}liked it`, cfg.like);
    else if (r.vibe === "meh") push(`${who}meh`, -cfg.meh);
    else if (r.vibe === "dislike") push(`${who}disliked it`, -cfg.dislike);
    else if (r.vibe === "hate") push(`${who}hated it`, -cfg.hate);
    if (r.look === "good") push(`${who}looks good`, cfg.looksGood);
    else if (r.look === "ugly") push(`${who}looks ugly`, -cfg.looksUgly);
    if (r.kitchen === "small") push(`${who}small kitchen`, -cfg.smallKitchen);
    else if (r.kitchen === "tiny") push(`${who}tiny kitchen`, -cfg.tinyKitchen);
  }
  return rows;
}

export function vibeScore(
  p: Scorable,
  ratings: Rating[],
  cfg: VibeConfig = DEFAULT_VIBE_CONFIG,
): number {
  const total = vibeBreakdown(p, ratings, cfg).reduce((a, r) => a + r.pts, 0);
  return Math.round(total * 10) / 10;
}

const KEY = "vibeConfig";

/**
 * Every VibeConfig field is a finite number, so anything else in the stored JSON
 * is dropped in favour of the default. Spreading the parsed object wholesale let
 * one bad value (a hand-edited string, a null, a NaN from an old bug) reach the
 * arithmetic in vibeBreakdown, and NaN propagates: the score, the sort order and
 * every tile's badge all go to NaN at once, with nothing on screen explaining
 * why. Unknown keys are dropped for the same reason.
 */
export function parseVibeConfig(raw: unknown): VibeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_VIBE_CONFIG;
  const src = raw as Record<string, unknown>;
  const out = { ...DEFAULT_VIBE_CONFIG };
  for (const k of Object.keys(DEFAULT_VIBE_CONFIG) as (keyof VibeConfig)[]) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function loadVibeConfig(): VibeConfig {
  if (typeof localStorage === "undefined") return DEFAULT_VIBE_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseVibeConfig(JSON.parse(raw)) : DEFAULT_VIBE_CONFIG;
  } catch {
    return DEFAULT_VIBE_CONFIG;
  }
}
export function saveVibeConfig(cfg: VibeConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

const LOCAL_OVERRIDE_KEY = "vibeConfigLocal";

/**
 * Per-browser opt-out of the shared server config (see use-vibe-config.ts).
 * Absent/false = off = the shared/server value wins, which is the default for
 * both profiles. true = this browser keeps whatever config is currently
 * showing and never syncs to/from the server.
 */
export function loadVibeConfigLocal(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(LOCAL_OVERRIDE_KEY) === "true";
  } catch {
    return false;
  }
}
export function saveVibeConfigLocal(local: boolean): void {
  try {
    localStorage.setItem(LOCAL_OVERRIDE_KEY, local ? "true" : "false");
  } catch {
    /* ignore */
  }
}
