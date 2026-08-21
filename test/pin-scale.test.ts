/**
 * Unit tests for MapView's pin-diameter scale (extracted to src/lib/pin-scale.ts
 * for testability). Linear in vibe score across [PIN_MIN, PIN_MAX], clamped at
 * both ends, with degenerate ranges collapsing to the midpoint rather than
 * dividing by zero.
 */
import assert from "node:assert/strict";
import { PIN_MIN, PIN_MAX, PIN_MID, pinDiameter, pinDiameterScale } from "../src/lib/pin-scale";

assert.equal(PIN_MIN, 5, "brief's stated minimum");
assert.equal(PIN_MAX, 50, "brief's stated maximum");
assert.equal(PIN_MID, 27.5, "midpoint of [5, 50]");

// --- pinDiameter(score, min, max) -------------------------------------------

assert.equal(pinDiameter(0, 0, 10), PIN_MIN, "lowest score in range -> exactly PIN_MIN");
assert.equal(pinDiameter(10, 0, 10), PIN_MAX, "highest score in range -> exactly PIN_MAX");
assert.equal(pinDiameter(5, 0, 10), (PIN_MIN + PIN_MAX) / 2, "midpoint score -> midpoint diameter");
assert.equal(pinDiameter(2.5, 0, 10), PIN_MIN + 0.25 * (PIN_MAX - PIN_MIN), "linear at 25% of the range");
assert.equal(pinDiameter(7.5, 0, 10), PIN_MIN + 0.75 * (PIN_MAX - PIN_MIN), "linear at 75% of the range");

// Clamping beyond both ends — a score outside [min, max] should never be
// reported (e.g. min/max computed from a stale/different pin set).
assert.equal(pinDiameter(-5, 0, 10), PIN_MIN, "below the range clamps to PIN_MIN, not negative");
assert.equal(pinDiameter(15, 0, 10), PIN_MAX, "above the range clamps to PIN_MAX, not beyond it");

// Degenerate: min === max (every visible pin scored the same) collapses to
// the midpoint regardless of the actual score value, rather than NaN from a
// division by zero.
assert.equal(pinDiameter(5, 5, 5), PIN_MID, "min === max -> midpoint, not division by zero");
assert.equal(pinDiameter(0, 5, 5), PIN_MID, "min === max -> midpoint even for a score outside that single value");

// A property with no/invalid vibe score renders sensibly (midpoint), not 0
// and not a crash.
assert.equal(pinDiameter(NaN, 0, 10), PIN_MID, "NaN score -> midpoint");
assert.equal(pinDiameter(Number.NaN, 0, 10), PIN_MID, "explicit NaN score -> midpoint");

// --- pinDiameterScale(scores) ------------------------------------------------

// Zero pins -> no crash, and every (hypothetical) score renders at the midpoint.
assert.equal(pinDiameterScale([])(7), PIN_MID, "zero pins -> midpoint, no crash");

// One pin -> no spread to express -> midpoint, not either extreme.
assert.equal(pinDiameterScale([42])(42), PIN_MID, "a single pin renders at the midpoint, not PIN_MAX");

// All-equal scores across several pins -> midpoint for all of them.
{
  const scale = pinDiameterScale([8, 8, 8]);
  assert.equal(scale(8), PIN_MID, "all-equal scores -> midpoint (not PIN_MIN, not PIN_MAX)");
}

// A real spread: lowest of the set -> PIN_MIN, highest -> PIN_MAX, others linear.
{
  const scale = pinDiameterScale([10, 20, 30]);
  assert.equal(scale(10), PIN_MIN, "lowest of the plotted set -> PIN_MIN");
  assert.equal(scale(30), PIN_MAX, "highest of the plotted set -> PIN_MAX");
  assert.equal(scale(20), (PIN_MIN + PIN_MAX) / 2, "middle score -> linear midpoint");
}

// Non-finite scores in the input set are excluded from the min/max
// computation (an unscored property shouldn't collapse the whole map's range).
{
  const scale = pinDiameterScale([10, NaN, 30]);
  assert.equal(scale(10), PIN_MIN, "NaN entries don't affect the computed min");
  assert.equal(scale(30), PIN_MAX, "NaN entries don't affect the computed max");
  assert.equal(scale(NaN), PIN_MID, "passing a NaN score through the built scale still renders at the midpoint");
}

console.log("✓ pin-scale.test: all assertions passed");
