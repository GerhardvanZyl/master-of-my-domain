/**
 * Unit tests for MapView's pin-diameter scale (src/lib/pin-scale.ts). Diameter
 * is driven by a score's rank among the plotted set (deduped, sorted), spread
 * evenly across [PIN_MIN, PIN_MAX], with degenerate ranges and ties collapsing
 * per the module docstring.
 */
import assert from "node:assert/strict";
import { PIN_MIN, PIN_MAX, PIN_MID, pinDiameterScale } from "../src/lib/pin-scale";

assert.equal(PIN_MIN, 5, "brief's stated minimum");
assert.equal(PIN_MAX, 50, "brief's stated maximum");
assert.equal(PIN_MID, 27.5, "midpoint of [5, 50]");

// --- Degenerate inputs collapse to PIN_MID, same as before the rank rewrite -

assert.equal(pinDiameterScale([])(7), PIN_MID, "zero pins -> midpoint, no crash");
assert.equal(pinDiameterScale([42])(42), PIN_MID, "a single pin renders at the midpoint, not PIN_MAX");

{
  const scale = pinDiameterScale([8, 8, 8]);
  assert.equal(scale(8), PIN_MID, "all-equal scores -> midpoint (not PIN_MIN, not PIN_MAX)");
}

// A property with no/invalid vibe score renders sensibly (midpoint), not 0
// and not a crash.
assert.equal(pinDiameterScale([10, 20, 30])(NaN), PIN_MID, "NaN score -> midpoint");
assert.equal(pinDiameterScale([])(NaN), PIN_MID, "NaN score against an empty set -> midpoint");

// Non-finite scores in the input set are excluded from the ranking (an
// unscored property shouldn't consume a rank slot or skew the range).
{
  const scale = pinDiameterScale([10, NaN, 30]);
  assert.equal(scale(10), PIN_MIN, "NaN entries don't affect the computed rank");
  assert.equal(scale(30), PIN_MAX, "NaN entries don't affect the computed rank");
  assert.equal(scale(NaN), PIN_MID, "passing a NaN score through the built scale still renders at the midpoint");
}

// --- Rank spread: lowest of the distinct set -> PIN_MIN, highest -> PIN_MAX,
// middle distinct values spread evenly by RANK, not by value -------------

{
  const scale = pinDiameterScale([10, 20, 30]);
  assert.equal(scale(10), PIN_MIN, "lowest of the plotted set -> PIN_MIN");
  assert.equal(scale(30), PIN_MAX, "highest of the plotted set -> PIN_MAX");
  assert.equal(scale(20), PIN_MID, "middle of 3 evenly-ranked distinct values -> the midpoint");
}

// The core fix: an outlier must not compress the rest of the range. Values
// [1, 2, 3, 4, 1000] are heavily skewed by raw value (a linear map would push
// 1..4 into a sliver near PIN_MIN) but are 5 equally-spaced RANKS, so they
// must land on 5 evenly-spaced diameters regardless of the outlier's size.
{
  const scale = pinDiameterScale([1, 2, 3, 4, 1000]);
  const step = (PIN_MAX - PIN_MIN) / 4;
  assert.equal(scale(1), PIN_MIN, "rank 0 -> PIN_MIN");
  assert.ok(Math.abs(scale(2) - (PIN_MIN + step)) < 1e-9, "rank 1 -> PIN_MIN + 1 step, unaffected by the outlier");
  assert.ok(
    Math.abs(scale(3) - (PIN_MIN + 2 * step)) < 1e-9,
    "rank 2 -> PIN_MIN + 2 steps, unaffected by the outlier",
  );
  assert.ok(
    Math.abs(scale(4) - (PIN_MIN + 3 * step)) < 1e-9,
    "rank 3 -> PIN_MIN + 3 steps, unaffected by the outlier",
  );
  assert.equal(scale(1000), PIN_MAX, "the outlier itself still reaches PIN_MAX");
}

// --- Ties: equal scores MUST get identical diameters, however many other
// distinct scores separate them from the extremes --------------------------

{
  const scale = pinDiameterScale([10, 10, 10, 20, 30, 30]);
  assert.equal(scale(10), PIN_MIN, "tied lowest scores share PIN_MIN");
  assert.equal(scale(30), PIN_MAX, "tied highest scores share PIN_MAX");
  // Calling the same score twice must be idempotent — this is what a naive
  // "sort the raw array, use index as rank" implementation gets wrong: two
  // equal scores land at adjacent array indices and would get two different
  // diameters. Ranking the DEDUPED value set (not raw position) avoids that.
  assert.equal(scale(10), scale(10), "repeated lookups of a tied score are identical");
}

// --- Order preservation: a strictly higher score must never yield a
// strictly smaller diameter — the property the whole feature rests on -------

{
  const values = [3, 1, 7, 4, 4, 9, 2, 15, 6, 4, 100, 0.5];
  const scale = pinDiameterScale(values);
  const sortedUnique = [...new Set(values)].sort((a, b) => a - b);
  for (let i = 1; i < sortedUnique.length; i++) {
    assert.ok(
      scale(sortedUnique[i]) >= scale(sortedUnique[i - 1]),
      `diameter(${sortedUnique[i]}) must be >= diameter(${sortedUnique[i - 1]})`,
    );
  }
}

// --- A score that was never in the plotted set (defensive only — MapView
// always builds the array from the same pins it renders) still gets a
// sensible, order-respecting, in-range diameter, not a crash --------------

{
  const scale = pinDiameterScale([10, 20, 30]);
  const between = scale(15);
  assert.equal(between, scale(10), "an unseen score between two ranks takes its lower rank-neighbour's diameter");
  assert.ok(
    between >= scale(10) && between < scale(20),
    "still order-respecting: no smaller than below, no bigger than above",
  );
  assert.equal(scale(-100), PIN_MIN, "an unseen score below the whole set clamps to PIN_MIN");
  assert.equal(scale(1000), PIN_MAX, "an unseen score above the whole set clamps to PIN_MAX");
}

console.log("✓ pin-scale.test: all assertions passed");
