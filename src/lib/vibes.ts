import type { Property } from "@/db/schema";

/**
 * "Vibes" score — starts at 100 and applies the deductions/bonuses the user
 * specified. Config values are stored as positive magnitudes; the sign is
 * applied here. Everything is configurable (persisted in localStorage by the
 * settings panel); DEFAULT_VIBE_CONFIG holds the user's original numbers.
 */
export interface VibeConfig {
  idealPrice: number;
  perStation250m: number; // −1 per 250 m from nearest station
  perAbove5000: number; // −1 per $5k above ideal
  perBelow10000: number; // −1 per $10k below ideal
  perGreenCrossKm: number; // −1 per 1 km from Green Cross Vets
  noPlaygrounds: number; // −5 if no playground within 500 m
  perFlinders5min: number; // −3 per 5 min travel to Flinders St
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
}

export const DEFAULT_VIBE_CONFIG: VibeConfig = {
  idealPrice: 850_000,
  perStation250m: 1,
  perAbove5000: 1,
  perBelow10000: 1,
  perGreenCrossKm: 1,
  noPlaygrounds: 5,
  perFlinders5min: 3,
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
>;

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
  const rows: BreakdownRow[] = [{ label: "Base score", pts: 100 }];
  const push = (label: string, pts: number) => {
    if (Math.abs(pts) >= 0.05) rows.push({ label, pts: Math.round(pts * 10) / 10 });
  };

  if (p.stationDistanceM != null)
    push(`Station ${p.stationDistanceM} m away`, -(p.stationDistanceM / 250) * cfg.perStation250m);
  if (p.priceNumeric != null) {
    if (p.priceNumeric > cfg.idealPrice)
      push("Above ideal price", -((p.priceNumeric - cfg.idealPrice) / 5000) * cfg.perAbove5000);
    else if (p.priceNumeric < cfg.idealPrice)
      push("Below ideal price", -((cfg.idealPrice - p.priceNumeric) / 10000) * cfg.perBelow10000);
  }
  if (p.greenCrossDistanceM != null)
    push("Distance to Green Cross vet", -(p.greenCrossDistanceM / 1000) * cfg.perGreenCrossKm);
  if (!p.playgrounds500m) push("No playground ≤500 m", -cfg.noPlaygrounds);
  if (p.ptMinutesToFlinders != null)
    push("Transit to Flinders St", -(p.ptMinutesToFlinders / 5) * cfg.perFlinders5min);
  // ponytail: only penalize a KNOWN-absent feature (0). null = not-yet-harvested,
  // so an un-inspected property isn't docked for missing data.
  if (p.hasEaves === 0) push("No all-around eaves", -cfg.noEaves);
  if (p.pergolaCovered === 0) push("No covered pergola", -cfg.noPergola);
  if (p.hasLawn === 0) push("No lawn", -cfg.noLawn);
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
export function loadVibeConfig(): VibeConfig {
  if (typeof localStorage === "undefined") return DEFAULT_VIBE_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_VIBE_CONFIG, ...JSON.parse(raw) } : DEFAULT_VIBE_CONFIG;
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
