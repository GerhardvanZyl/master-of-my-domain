import assert from "node:assert/strict";
import { TILE, project } from "../src/lib/mercator";
import {
  DEFAULT_VIBE_CONFIG,
  parseVibeConfig,
  vibeBreakdown,
  vibeScore,
  type Rating,
} from "../src/lib/vibes";

// --- Web Mercator ----------------------------------------------------------
// Null Island sits dead centre of the z=0 world tile.
const o = project(0, 0, 0);
assert.equal(Math.round(o.x), TILE / 2);
assert.equal(Math.round(o.y), TILE / 2);
// Longitude is linear: ±180° are the world edges.
assert.equal(Math.round(project(0, -180, 3).x), 0);
assert.equal(Math.round(project(0, 180, 3).x), TILE * 8);
// North is up, and each zoom step doubles the pixel scale.
assert.ok(project(40, 0, 5).y < project(-40, 0, 5).y);
assert.equal(project(-37.9, 144.75, 14).x, project(-37.9, 144.75, 13).x * 2);
// Melbourne lands in the tile the standard slippy-map formula says it should
// at z=12 — x=(lng+180)/360·2^z, y=(1−ln(tanφ+secφ)/π)/2·2^z.
const mel = project(-37.8136, 144.9631, 12);
assert.equal(Math.floor(mel.x / TILE), 3697);
assert.equal(Math.floor(mel.y / TILE), 2513);

// --- Vibes scoring ---------------------------------------------------------
const p = {
  priceNumeric: 900_000,
  stationDistanceM: 1200,
  greenCrossDistanceM: 8000,
  playgrounds500m: 0,
  ptMinutesToFlinders: 55,
  hasEaves: 0,
  pergolaCovered: null,
  hasLawn: 1,
  beds: 3,
  commonAreasCount: 2,
  masterBedSqm: 15,
  avgOtherBedSqm: null,
  cons: "busy road\n\nno side access\n",
};
const ratings: Rating[] = [
  { profile: "gerhard", vibe: "like", look: "good", kitchen: null },
  { profile: "johanita", vibe: "meh", look: null, kitchen: "small" },
];

const rows = vibeBreakdown(p, ratings, DEFAULT_VIBE_CONFIG);
// The panel must add up to the number shown on the card.
assert.equal(
  Math.round(rows.reduce((a, r) => a + r.pts, 0) * 10) / 10,
  vibeScore(p, ratings, DEFAULT_VIBE_CONFIG),
);
assert.equal(rows[0].label, "Base score");
assert.equal(rows[0].pts, DEFAULT_VIBE_CONFIG.baseScore);
// The starting points are configurable, and the base row must follow the config.
assert.equal(
  vibeBreakdown(p, ratings, { ...DEFAULT_VIBE_CONFIG, baseScore: 250 })[0].pts,
  250,
);
// Both profiles' reactions count separately, and each is attributed.
assert.ok(rows.some((r) => r.label === "gerhard: liked it" && r.pts === 25));
assert.ok(rows.some((r) => r.label === "johanita: meh" && r.pts === -10));
// Only KNOWN-absent features are penalised: eaves=0 docks, pergola=null doesn't.
assert.ok(rows.some((r) => r.label === "No all-around eaves"));
assert.ok(!rows.some((r) => r.label.includes("pergola")));
assert.ok(!rows.some((r) => r.label === "No lawn"));
// Room-size terms: +5×2 living areas, −5×1 missing bed, −2×3 m² of master.
assert.ok(rows.some((r) => r.label === "2 living areas" && r.pts === 10));
assert.ok(rows.some((r) => r.label === "Only 3 bedrooms" && r.pts === -5));
assert.ok(rows.some((r) => r.label === "Master bed 15 m²" && r.pts === -6));
assert.ok(!rows.some((r) => r.label.includes("Other beds")));
// −3 per listed con; blank lines don't count.
assert.ok(rows.some((r) => r.label === "2 cons listed" && r.pts === -6));
// The vet distance is capped: 8 km costs 8, 80 km still costs the 20 km cap.
const vet = (m: number) =>
  vibeBreakdown({ ...p, greenCrossDistanceM: m }, [], DEFAULT_VIBE_CONFIG)
    .find((r) => r.label === "Distance to Green Cross vet")!.pts;
assert.equal(vet(8000), -8);
assert.equal(vet(80_000), -20);
// Zero-magnitude terms are dropped rather than listed as "0".
assert.ok(rows.every((r) => r.pts !== 0));

// The two distance curves are independent, and exponent 1 is the old linear rule.
const term = (label: string, cfg: Partial<typeof DEFAULT_VIBE_CONFIG>) =>
  vibeBreakdown(p, [], { ...DEFAULT_VIBE_CONFIG, ...cfg }).find((r) =>
    r.label.startsWith(label),
  )!.pts;
assert.equal(term("Station", {}), -4.8, "1200 m = 4.8 units × 1, linear");
assert.equal(term("Transit", {}), -33, "55 min = 11 units × 3, linear");
// Squaring the station curve must not touch the Flinders term, and vice versa.
assert.equal(term("Station", { stationExponent: 2 }), -23);
assert.equal(term("Transit", { stationExponent: 2 }), -33);
assert.equal(term("Transit", { flindersExponent: 2 }), -363);
assert.equal(term("Station", { flindersExponent: 2 }), -4.8);
// A stored 0 or negative exponent is clamped, not allowed to flatten the
// penalty to a constant or return Infinity at zero distance.
assert.ok(Number.isFinite(term("Station", { stationExponent: 0 })));
assert.ok(
  Number.isFinite(
    vibeBreakdown({ ...p, stationDistanceM: 0 }, [], {
      ...DEFAULT_VIBE_CONFIG,
      stationExponent: -2,
    }).reduce((a, r) => a + r.pts, 0),
  ),
);

// --- Price deviation curves -------------------------------------------------
// p is $50k above ideal (900_000 vs 850_000 = 10 units of $5k). A second
// fixture, priced below ideal, exercises the other branch without mutating p.
const pBelow = { ...p, priceNumeric: 800_000 }; // $50k under ideal = 5 units of $10k

// The defaults must reproduce today's numbers exactly — this is the property
// that makes the change safe to ship.
assert.equal(term("Above ideal price", {}), -10, "10 units × 1, linear, unchanged by default");
assert.equal(
  vibeScore(p, ratings, DEFAULT_VIBE_CONFIG),
  942.2,
  "the whole default-config score is unchanged, not just the one row",
);

// The exponent actually bites.
assert.equal(term("Above ideal price", { priceAboveExponent: 2 }), -100, "10² × 1 = -100");

// Mutual independence: each of the four exponents moves only its own term.
assert.equal(term("Station", { priceAboveExponent: 2 }), -4.8, "price exponent doesn't touch Station");
assert.equal(term("Transit", { priceAboveExponent: 2 }), -33, "price exponent doesn't touch Transit");
assert.equal(term("Above ideal price", { stationExponent: 2 }), -10, "stationExponent doesn't touch price");
assert.equal(term("Above ideal price", { flindersExponent: 2 }), -10, "flindersExponent doesn't touch price");

const belowTerm = (cfg: Partial<typeof DEFAULT_VIBE_CONFIG>) =>
  vibeBreakdown(pBelow, [], { ...DEFAULT_VIBE_CONFIG, ...cfg }).find((r) =>
    r.label.startsWith("Below ideal price"),
  )!.pts;
assert.equal(belowTerm({}), -5, "5 units × 1, linear, unchanged by default");
assert.equal(belowTerm({ priceBelowExponent: 2 }), -25, "5² × 1 = -25");
assert.equal(belowTerm({ priceAboveExponent: 2 }), -5, "priceAboveExponent doesn't touch the below-ideal term");
assert.equal(belowTerm({ stationExponent: 2 }), -5, "stationExponent doesn't touch the below-ideal term");
assert.equal(belowTerm({ flindersExponent: 2 }), -5, "flindersExponent doesn't touch the below-ideal term");
assert.equal(
  vibeBreakdown(pBelow, [], { ...DEFAULT_VIBE_CONFIG, priceBelowExponent: 2 }).find((r) =>
    r.label.startsWith("Station"),
  )!.pts,
  -4.8,
  "priceBelowExponent doesn't touch Station",
);
assert.equal(
  vibeBreakdown(pBelow, [], { ...DEFAULT_VIBE_CONFIG, priceBelowExponent: 2 }).find((r) =>
    r.label.startsWith("Transit"),
  )!.pts,
  -33,
  "priceBelowExponent doesn't touch Transit",
);

// A stored 0 or negative exponent is clamped for both new fields too.
assert.ok(Number.isFinite(term("Above ideal price", { priceAboveExponent: 0 })));
assert.ok(Number.isFinite(belowTerm({ priceBelowExponent: 0 })));
assert.ok(
  Number.isFinite(
    vibeBreakdown(p, [], { ...DEFAULT_VIBE_CONFIG, priceAboveExponent: -2 }).reduce(
      (a, r) => a + r.pts,
      0,
    ),
  ),
  "negative priceAboveExponent stays finite",
);
assert.ok(
  Number.isFinite(
    vibeBreakdown(pBelow, [], { ...DEFAULT_VIBE_CONFIG, priceBelowExponent: -2 }).reduce(
      (a, r) => a + r.pts,
      0,
    ),
  ),
  "negative priceBelowExponent stays finite",
);

// Price exactly at ideal: neither branch runs, at any exponent.
const pAtIdeal = { ...p, priceNumeric: DEFAULT_VIBE_CONFIG.idealPrice };
assert.ok(
  !vibeBreakdown(pAtIdeal, [], { ...DEFAULT_VIBE_CONFIG, priceAboveExponent: 3, priceBelowExponent: 3 }).some(
    (r) => r.label.includes("ideal price"),
  ),
  "price at ideal produces no price row, exponents notwithstanding",
);

// --- "just no" vibe and "too small" size: new -250 / -100 axes -------------
// justno is a fifth mutually-exclusive vibe value (like/meh/dislike/hate/justno).
assert.ok(
  vibeBreakdown(p, [{ profile: "gerhard", vibe: "justno" }], DEFAULT_VIBE_CONFIG).some(
    (r) => r.label === "gerhard: just no" && r.pts === -250,
  ),
  "justno deducts the configured default magnitude, sign applied here",
);
assert.equal(
  vibeBreakdown(p, [{ vibe: "justno" }], { ...DEFAULT_VIBE_CONFIG, justNo: 999 })
    .find((r) => r.label === "just no")!.pts,
  -999,
  "the magnitude is read from config, not hard-coded",
);
// size is an axis independent of look/kitchen: a property can be liked AND
// too small at the same time (both rows present simultaneously, not exclusive).
{
  const rows = vibeBreakdown(
    p,
    [{ profile: "gerhard", vibe: "like", look: "good", kitchen: "small", size: "small" }],
    DEFAULT_VIBE_CONFIG,
  );
  assert.ok(rows.some((r) => r.label === "gerhard: liked it" && r.pts === 25));
  assert.ok(rows.some((r) => r.label === "gerhard: too small" && r.pts === -100));
  assert.ok(rows.some((r) => r.label === "gerhard: small kitchen" && r.pts === -10));
}
assert.equal(
  vibeBreakdown(p, [{ size: "small" }], { ...DEFAULT_VIBE_CONFIG, tooSmall: 40 })
    .find((r) => r.label === "too small")!.pts,
  -40,
  "the too-small magnitude is read from config, not hard-coded",
);
assert.ok(
  !vibeBreakdown(p, [{ size: null }], DEFAULT_VIBE_CONFIG).some((r) => r.label.includes("too small")),
  "no size row when size is null",
);

// --- parseVibeConfig: one bad stored value must not NaN the whole grid -------
// Spreading the parsed JSON used to let a string/null/NaN reach the arithmetic,
// and NaN propagates to the score, the sort and every tile badge at once.
assert.deepEqual(parseVibeConfig(null), DEFAULT_VIBE_CONFIG, "null -> defaults");
assert.deepEqual(parseVibeConfig("nope"), DEFAULT_VIBE_CONFIG, "non-object -> defaults");
assert.equal(parseVibeConfig({ like: 40 }).like, 40, "a valid override is kept");
assert.equal(
  parseVibeConfig({ like: 40 }).hate,
  DEFAULT_VIBE_CONFIG.hate,
  "untouched keys keep their default",
);
for (const bad of [{ like: "40" }, { like: null }, { like: NaN }, { like: Infinity }, { like: {} }]) {
  assert.equal(
    parseVibeConfig(bad).like,
    DEFAULT_VIBE_CONFIG.like,
    `rejected ${JSON.stringify(bad)}`,
  );
}
assert.ok(
  !("bogus" in parseVibeConfig({ bogus: 1 })),
  "unknown keys are dropped, not carried into the config",
);
// The whole point: a corrupt store still yields a real number for every score.
const corrupt = parseVibeConfig({ like: "40", idealPrice: null, perStation250m: NaN });
assert.ok(
  Number.isFinite(vibeScore(p, [{ profile: "g", vibe: "like" }], corrupt)),
  "score stays finite with a corrupt stored config",
);

console.log("features.test.ts ok");
