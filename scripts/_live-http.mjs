// Shared HTTP-only helpers for reading LIVE-app state via the Next.js RSC
// flight stream — used by both _tag-stragglers.ts (job 1) and
// _recover-floorplans.ts (job 2), 2026-08-23 straggler round.
//
// Why the flight stream instead of the rendered-HTML badge regex
// scripts/_tag-remote.ts and scripts/_audit-hero-floorplan.mjs use: the
// property detail page (src/app/property/[id]/page.tsx) calls
// getPropertyImages(id) server-side and passes the FULL result — including
// the exact DB `roomType`/`notes`/`taggedBy`/`confidence` columns, not just a
// rendered badge word — straight into PhotoGrid and HeroGallery, both
// "use client" components. Next therefore serializes that whole array,
// verbatim, into the page's self.__next_f.push(...) stream. Reading it
// directly is strictly more precise than reconstructing "is this image
// tagged" or "is this the hero" from a rendered <span> badge: it IS the DB
// row, not an approximation of it tuned against markup that could drift.
// Confirmed empirically against a live property page before relying on it
// (see conversation notes / _probe-hero-notes.mjs): a property with
// notes='hero' on its cover image showed `"notes":"hero"` verbatim in the
// flight JSON, at the exact "images":[{...}] anchor used below.
//
// Known, inherent limitation (applies equally to the badge-regex approach):
// only VISIBLE images ever reach the client (isVisibleImage() in
// src/db/queries/properties.ts filters before the array is passed to any
// component), so an image that is neither exclude-tagged nor
// aspect-heuristic-visible, and also carries no tag row at all, is invisible
// to ANY http scan of the rendered page. There is no endpoint that lists raw,
// unfiltered image rows (checked src/app/api/images, src/app/api/properties —
// neither exposes one). This can only under-count "untagged", never
// over-count or misreport a tag value.

const FLIGHT_RE = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

export async function fetchFlightFlat(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const html = await res.text();
  return [...html.matchAll(FLIGHT_RE)].map((m) => JSON.parse('"' + m[1] + '"')).join("");
}

/**
 * Bracket-matches the array literal starting at the first `[` after the
 * literal `"<key>":[` anchor and JSON.parses it. Same brace-counting
 * algorithm as scripts/_audit-hero-floorplan.mjs's propsOf(), generalised to
 * an arbitrary key so it works for both the page-level "properties" array and
 * the per-property "images" array.
 *
 * `opts.throwOnMissing` distinguishes "the parse did not produce a trustworthy
 * array" from "anchor present, array genuinely empty" — both silently returned
 * `[]` before, which is exactly the ambiguity scripts/_groups-from-tags.mjs's
 * fail-closed guard needs to resolve (arch-003, round 2; tech-005/arch-005,
 * round 3). Two distinct failure shapes count as "not trustworthy" and both
 * throw under the option: the anchor is absent entirely (wrong key,
 * unreachable flight prop), or the anchor is present but the bracket matcher
 * never finds its close before `flat` ends (a response truncated mid-array).
 * A live check confirmed `/rooms?group=<id>` serialises the `"columns":[]`
 * anchor even for an empty group, so a caller that needs "did parsing
 * actually work" should ask this function, not compare unrelated counts from
 * another query layer.
 */
export function extractArray(flat, key, opts = {}) {
  const anchor = `"${key}":[`;
  const i = flat.indexOf(anchor);
  if (i < 0) {
    if (opts.throwOnMissing) {
      throw new Error(`extractArray: anchor ${JSON.stringify(anchor)} not found in flight stream`);
    }
    return [];
  }
  const start = flat.indexOf("[", i);
  let d = 0,
    end = -1,
    inStr = false,
    esc = false;
  for (let k = start; k < flat.length; k++) {
    const c = flat[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") {
      d--;
      if (d === 0) {
        end = k;
        break;
      }
    }
  }
  if (end < 0) {
    if (opts.throwOnMissing) {
      throw new Error(
        `extractArray: anchor ${JSON.stringify(anchor)} found but the array never closed (truncated response)`,
      );
    }
    return [];
  }
  const arr = JSON.parse(flat.slice(start, end + 1));
  // React Flight doubles a leading "$" in string values (see
  // _audit-hero-floorplan.mjs) — undo it on every top-level string field.
  for (const o of arr) {
    if (o && typeof o === "object") {
      for (const k2 of Object.keys(o)) {
        if (typeof o[k2] === "string" && o[k2].startsWith("$$")) o[k2] = o[k2].slice(1);
      }
    }
  }
  return arr;
}

/** Every property on the live app: VIC (incl. sold/withdrawn) + NSW. */
export async function getAllLiveProperties(base) {
  const vic = extractArray(await fetchFlightFlat(`${base}/`), "properties");
  const nsw = extractArray(await fetchFlightFlat(`${base}/sydney`), "properties");
  return [...vic, ...nsw];
}

/** The exact ImageWithTag rows (id/propertyId/sourceUrl/localPath/ordinal/
 * width/height/alt/roomType/notes/taggedBy/confidence) getPropertyImages()
 * returned for this property, per the note above (visible images only). */
export async function getLiveImages(base, propertyId) {
  const flat = await fetchFlightFlat(`${base}/property/${propertyId}`);
  return extractArray(flat, "images");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Politeness: at most `limit` requests in flight, small stagger between. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      await sleep(50);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
