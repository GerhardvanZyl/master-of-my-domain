import { sqlite } from "../src/db/client";

/**
 * Repair properties whose address was mis-extracted as the site name ("Domain").
 * The listing URL slug carries the real address, e.g.
 *   1-boathaven-road-point-cook-vic-3030-2020293779
 *     -> "1 Boathaven Road, Point Cook VIC 3030"
 * Pass --write to apply; default is a dry run.
 */
const TITLE_EXCEPTIONS: Record<string, string> = { vic: "VIC", nsw: "NSW", qld: "QLD" };
const titleCase = (w: string) =>
  TITLE_EXCEPTIONS[w] ?? w.charAt(0).toUpperCase() + w.slice(1);

export function addressFromSlug(url: string): string | null {
  const slug = new URL(url).pathname.replace(/^\/|\/$/g, "");
  // trailing listing id, then postcode, then state, then the suburb+street words
  const m = slug.match(/^(.+)-([a-z]{2,3})-(\d{4})-\d{6,}$/);
  if (!m) return null;
  const [, streetAndSuburb, state, postcode] = m;
  const words = streetAndSuburb.split("-");
  // Suburbs here are 1-3 words; we can't know the split from the slug alone, so
  // ponytail: use the DB's suburb when present and peel it off the tail.
  return `${words.map(titleCase).join(" ")} ${state.toUpperCase()} ${postcode}`;
}

/** Prefer the stored suburb to split "street, suburb" correctly. */
function build(url: string, suburb: string | null): string | null {
  const flat = addressFromSlug(url);
  if (!flat) return null;
  if (!suburb) return flat;
  const i = flat.toLowerCase().indexOf(" " + suburb.toLowerCase() + " ");
  if (i === -1) return flat;
  return `${flat.slice(0, i)}, ${flat.slice(i + 1)}`;
}

const rows = sqlite
  .prepare(
    `SELECT id, address, suburb, listing_url AS url FROM properties
      WHERE address IS NULL OR address = '' OR address = 'Domain'`,
  )
  .all() as { id: string; address: string | null; suburb: string | null; url: string }[];

const write = process.argv.includes("--write");
const upd = sqlite.prepare("UPDATE properties SET address = ?, updated_at = ? WHERE id = ?");
let fixed = 0;
for (const r of rows) {
  const next = build(r.url, r.suburb);
  if (!next) {
    console.log("SKIP (unparsable slug):", r.url);
    continue;
  }
  fixed++;
  if (write) upd.run(next, new Date().toISOString(), r.id);
  else if (fixed <= 5) console.log(`${r.address} -> ${next}`);
}
console.log(`${write ? "updated" : "would update"} ${fixed} of ${rows.length}`);

// ponytail: self-check instead of a test file — fails loudly if the regex rots.
if (process.argv.includes("--check")) {
  const got = addressFromSlug(
    "https://www.domain.com.au/1-boathaven-road-point-cook-vic-3030-2020293779",
  );
  if (got !== "1 Boathaven Road Point Cook VIC 3030") throw new Error(`slug parse broke: ${got}`);
  console.log("self-check ok");
}
