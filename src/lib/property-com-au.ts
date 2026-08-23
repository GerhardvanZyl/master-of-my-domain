/**
 * Validation for the property.com.au enrichment fields (propertyComAuUrl,
 * yearBuilt). The URL is externally sourced and gets rendered as a live link,
 * so it's treated as untrusted at both ends: `sanitize*` below gates writes in
 * db/queries/load.ts (the one path both the CLI and POST /api/batch use), and
 * the property detail page re-validates before it ever emits an <a href>, in
 * case a row was written by some other path.
 *
 * Each sanitizer returns:
 *   - `null`      the caller explicitly asked to clear the field
 *   - `undefined` no value was supplied, or the supplied value is malformed —
 *                 treated as "not sent" so a garbage value can never silently
 *                 null out a previously-good one on a partial update
 *   - the value   it passed validation
 */

const PROPERTY_COM_AU_HOST = "www.property.com.au";

export function sanitizePropertyComAuUrl(v: string | null | undefined): string | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  // LoadItem is a compile-time cast over unvalidated JSON, so `v` may not
  // actually be a string at runtime. new URL() coerces its argument via
  // toString() before parsing, so without this check a non-string (e.g. an
  // array) that stringifies to a valid URL would pass through unchanged and
  // reach the SQLite binder, which throws on a non-primitive bind.
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" && u.hostname === PROPERTY_COM_AU_HOST) return v;
  } catch {
    // not a parseable URL at all
  }
  return undefined;
}

/** Same rule, for the render path — a plain boolean rather than tri-state. */
export function isValidPropertyComAuUrl(v: string | null | undefined): v is string {
  return sanitizePropertyComAuUrl(v) === v && v != null;
}

/**
 * Fallback for when there is no stored property.com.au URL (true for every
 * row on the live app today — the enrichment column has never been
 * backfilled): a Google search scoped to the site, built from whatever
 * address text the property has.
 *
 * The inputs are untrusted, externally scraped DB text rendered straight into
 * a live href, so every part goes through URLSearchParams rather than string
 * concatenation — that's what makes `&`, `#`, `?`, quotes, newlines, or a
 * `javascript:` prefix in an address land as inert characters inside the `q`
 * parameter instead of breaking out of it or the URL. The result is always an
 * `https://www.google.com/search?...` URL; content can change what it
 * searches for, never where it points.
 *
 * Returns `undefined` (this module's established "no usable answer"
 * sentinel — see the sanitizers above) when every field is empty/null, so a
 * caller can omit the row rather than link to a search for nothing.
 */
export function propertyComAuSearchUrl(
  address: string | null | undefined,
  suburb: string | null | undefined,
  state: string | null | undefined,
  postcode: string | null | undefined,
): string | undefined {
  const parts = [address, suburb, state, postcode]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;

  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", `site:property.com.au ${parts.join(" ")}`);
  return url.toString();
}

// Oldest known-standing house stock in this dataset's search area is well
// after 1800; the +1 headroom covers off-the-plan listings advertising next
// year's completion. Wide enough to never reject a real answer, narrow enough
// to catch the "0 / 999 / 3000" typo class the brief calls out.
const MIN_YEAR_BUILT = 1800;

export function sanitizeYearBuilt(v: number | string | null | undefined): number | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  // The documented extraction path is a regex over an embedded JSON blob
  // (see notes.md), whose capture group is a STRING — "2008", not 2008 — so a
  // numeric string has to be accepted here rather than silently rejected on
  // the very sync round this column exists to be populated by. Anything that
  // isn't a whole-number string (garbage, "2008.5", "") is still rejected,
  // same as any other non-string/non-integer input falls through to NaN below.
  const n = typeof v === "string" ? (/^\d+$/.test(v.trim()) ? Number(v) : NaN) : v;
  if (!Number.isInteger(n)) return undefined;
  const maxYear = new Date().getFullYear() + 1;
  if (n < MIN_YEAR_BUILT || n > maxYear) return undefined;
  return n;
}
