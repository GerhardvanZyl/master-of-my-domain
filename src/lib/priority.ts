/**
 * Ranking for the listing views. Two factors, higher score shown first:
 *  - closeness to the $850k sweet spot (dominant — further away ranks lower)
 *  - more bedrooms (a boost)
 * Scale: being ~$25k off target costs about one bedroom of priority, so price
 * proximity leads but bedrooms can break ties / lift a slightly-off listing.
 * Missing price (e.g. "Contact Agent") sinks to the bottom.
 */
export const TARGET_PRICE = 850_000;
export const PRICE_PER_BED = 25_000;

export function priorityScore(
  beds: number | null,
  priceNumeric: number | null,
): number {
  if (priceNumeric == null) return -Infinity;
  const pricePenalty = Math.abs(priceNumeric - TARGET_PRICE) / PRICE_PER_BED;
  return (beds ?? 0) - pricePenalty;
}
