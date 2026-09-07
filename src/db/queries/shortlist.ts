import { sqlite } from "../client";

/**
 * Mirrors the shortlist FEATURE on domain.com.au (not shortlist_tag, this
 * app's own maybe/rejected triage column, which this never touches) —
 * storage + write path only; harvesting the real shortlist off domain.com.au
 * is out of scope here (see the brief).
 *
 * A full replace: the caller sends the current shortlist as it stands on
 * Domain, so every OTHER Domain-sourced property is cleared, not just left
 * alone. Idempotent — re-sending the same list changes nothing on the second
 * call. Unmatched URLs are reported in `unknown` rather than thrown, so one
 * stale/mistyped URL can't fail the whole sync.
 *
 * Its own module rather than a function on status.ts — that file is
 * documented as sale-status and price-observation writes, and this is
 * neither (same reasoning that keeps status.ts from growing a tag-editing
 * function).
 */
export function setDomainShortlist(
  listingUrls: string[],
): { shortlisted: number; cleared: number; unknown: string[] } {
  const urls = [...new Set(listingUrls)];
  const placeholders = urls.map(() => "?").join(",");

  const rows = urls.length
    ? (sqlite
        .prepare(`SELECT id, listing_url u FROM properties WHERE listing_url IN (${placeholders})`)
        .all(...urls) as { id: string; u: string }[])
    : [];
  const matchedUrls = new Set(rows.map((r) => r.u));
  const unknown = urls.filter((u) => !matchedUrls.has(u));
  const ids = rows.map((r) => r.id);

  if (ids.length) {
    sqlite
      .prepare(`UPDATE properties SET domain_shortlisted = 1 WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(...ids);
  }

  // A non-empty list where NOTHING matched (urls.length > 0 but ids.length ===
  // 0) must not fall through to the empty-list clear-all branch below -- that
  // would wipe every Domain property's shortlist flag on a bad/mistyped URL
  // list rather than an intentional "clear everything" call.
  const cleared =
    urls.length > 0 && ids.length === 0
      ? 0
      : ids.length
        ? sqlite
            .prepare(
              `UPDATE properties SET domain_shortlisted = 0
                 WHERE source_site = 'domain' AND id NOT IN (${ids.map(() => "?").join(",")})`,
            )
            .run(...ids).changes
        : sqlite.prepare(`UPDATE properties SET domain_shortlisted = 0 WHERE source_site = 'domain'`).run()
            .changes;

  return { shortlisted: ids.length, cleared, unknown };
}
