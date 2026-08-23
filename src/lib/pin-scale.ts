/**
 * Pure scale for MapView's pin diameter — extracted out of the component for
 * testability.
 *
 * Diameter is driven by a score's RANK among the plotted scores, not its raw
 * value: the deduplicated, sorted scores are spread evenly across
 * [PIN_MIN, PIN_MAX], so a couple of outlier scores can no longer compress the
 * whole middle of the population into a few pixels the way a linear
 * value->diameter map did (measured on the live app across 345 pins: a linear
 * map put the middle half of all properties — p25 to p75 — inside an 8px band
 * of the full 45px range; see notes.md).
 *
 * Ties: ranking is over the DEDUPED sorted values, and a score is looked up by
 * its own value — so two equal scores always resolve to the same map entry
 * and the same diameter. (The naive version — sort the raw array and use
 * index as rank — breaks this: two equal scores land at adjacent indices and
 * get different diameters.)
 *
 * Degenerate ranges (no finite scores, one distinct finite score, or every
 * finite score equal) collapse to the midpoint: there's no "more" or "less"
 * to express among the plotted pins, so splitting the difference is the only
 * reading that claims nothing about the data (see notes.md — PIN_MAX would
 * assert top-tier, PIN_MIN the opposite).
 */
export const PIN_MIN = 5;
export const PIN_MAX = 50;
export const PIN_MID = (PIN_MIN + PIN_MAX) / 2;

/**
 * Builds the score -> diameter function for a set of scores (e.g. every
 * currently-plotted pin's vibe score).
 *
 * All sorting/deduping/ranking happens once, here, when the closure is built.
 * The returned function is an O(1) Map lookup for any score that was present
 * in `scores` — the case MapView actually hits: it builds this array from the
 * same pins it then calls the function on, once per pin, so there is no
 * per-pin scan of the input and rendering stays O(n) overall, not O(n²). A
 * score that was NOT in `scores` — not expected in practice, handled only
 * defensively — falls back to an O(log n) binary search and takes its lower
 * rank-neighbour's diameter, so it still gets an order-respecting diameter
 * instead of a crash or a nonsense value.
 *
 * Non-finite scores are excluded from the ranking entirely; a non-finite
 * score passed to the returned function always renders at PIN_MID. Zero
 * finite scores, exactly one distinct finite score, or every finite score
 * equal all collapse to PIN_MID too — there is nothing to rank against.
 */
export function pinDiameterScale(scores: number[]): (score: number) => number {
  const finite = scores.filter((s) => Number.isFinite(s));
  if (finite.length === 0) return () => PIN_MID;

  const uniqueSorted = [...new Set(finite)].sort((a, b) => a - b);
  const k = uniqueSorted.length;
  if (k === 1) return () => PIN_MID;

  // Dense rank: the i-th distinct value (0-indexed) maps to i / (k - 1), so
  // ranks span the full [PIN_MIN, PIN_MAX] range regardless of how the raw
  // values themselves are distributed — an outlier is just "the highest
  // rank", not a value that stretches the axis.
  const diameterByValue = new Map<number, number>();
  uniqueSorted.forEach((value, i) => {
    diameterByValue.set(value, PIN_MIN + (i / (k - 1)) * (PIN_MAX - PIN_MIN));
  });

  // Defensive-only path: a score absent from the original array. Binary
  // search for its rank-neighbours and take the lower one's diameter — still
  // monotonic in score, just not backed by an actual rank.
  const nearestBelow = (score: number): number => {
    if (score <= uniqueSorted[0]) return PIN_MIN;
    if (score >= uniqueSorted[k - 1]) return PIN_MAX;
    let lo = 0;
    let hi = k - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (uniqueSorted[mid] <= score) lo = mid;
      else hi = mid;
    }
    return diameterByValue.get(uniqueSorted[lo])!;
  };

  return (score: number) => {
    if (!Number.isFinite(score)) return PIN_MID;
    const exact = diameterByValue.get(score);
    return exact !== undefined ? exact : nearestBelow(score);
  };
}
