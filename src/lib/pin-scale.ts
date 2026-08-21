/**
 * Pure scale for MapView's pin diameter — extracted out of the component for
 * testability. Linear in vibe score across [PIN_MIN, PIN_MAX], clamped at
 * both ends. Degenerate ranges (no scores, one score, or every score equal)
 * collapse to the midpoint: there's no "more" or "less" to express among the
 * plotted pins, so splitting the difference is the only reading that claims
 * nothing about the data (see notes.md — PIN_MAX would assert top-tier,
 * PIN_MIN the opposite).
 */
export const PIN_MIN = 5;
export const PIN_MAX = 50;
export const PIN_MID = (PIN_MIN + PIN_MAX) / 2;

/**
 * score -> diameter, given the [min, max] range actually present among the
 * currently-plotted pins. A non-finite score, or a non-finite/degenerate
 * (min === max) range, renders at PIN_MID rather than dividing by zero.
 */
export function pinDiameter(score: number, min: number, max: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(min) || !Number.isFinite(max)) return PIN_MID;
  const range = max - min;
  const t = range === 0 ? 0.5 : (score - min) / range;
  return Math.min(PIN_MAX, Math.max(PIN_MIN, PIN_MIN + t * (PIN_MAX - PIN_MIN)));
}

/**
 * Builds the score -> diameter function for a set of scores (e.g. every
 * currently-plotted pin's vibe score). Non-finite scores are excluded from
 * the min/max computation; zero finite scores means every pin (including one
 * with a real score later passed in) renders at PIN_MID, same as a degenerate
 * range — there's nothing to compare against.
 */
export function pinDiameterScale(scores: number[]): (score: number) => number {
  const finite = scores.filter((s) => Number.isFinite(s));
  if (finite.length === 0) return () => PIN_MID;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return (score: number) => pinDiameter(score, min, max);
}
