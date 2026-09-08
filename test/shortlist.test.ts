/**
 * Offline test of src/db/queries/shortlist.ts — the write path for the
 * "shortlist FEATURE on domain.com.au" mirror (domain_shortlisted), which is
 * unrelated to shortlist_tag (this app's own maybe/rejected triage column).
 * Temp DB, set BEFORE importing app modules — same pattern as batch.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-shortlist-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

const URL_A = "https://www.domain.com.au/1-alpha-st-point-cook-vic-3030-2020000001";
const URL_B = "https://www.domain.com.au/2-beta-st-point-cook-vic-3030-2020000002";
const URL_C = "https://www.domain.com.au/3-gamma-st-point-cook-vic-3030-2020000003";
const URL_REA = "https://www.realestate.com.au/property-house-vic-point+cook-999999999";
const URL_UNKNOWN = "https://www.domain.com.au/nope-does-not-exist-1234567";

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { setDomainShortlist } = await import("../src/db/queries/shortlist");
  migrate();

  const now = new Date().toISOString();
  const insertProp = sqlite.prepare(
    `INSERT INTO properties (id, source_site, listing_url, address, shortlist_tag, scraped_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProp.run("propA", "domain", URL_A, "1 Alpha St", null, now, now, now);
  insertProp.run("propB", "domain", URL_B, "2 Beta St", null, now, now, now);
  insertProp.run("propC", "domain", URL_C, "3 Gamma St", "rejected", now, now, now);
  insertProp.run("propRea", "rea", URL_REA, "9 Rea St", null, now, now, now);

  const flags = () =>
    sqlite
      .prepare("SELECT id, domain_shortlisted d, shortlist_tag t FROM properties ORDER BY id")
      .all() as { id: string; d: number | null; t: string | null }[];

  // --- sets the given URLs to 1, clears every OTHER domain-sourced property ---
  const r1 = setDomainShortlist([URL_A, URL_B]);
  assert.equal(r1.shortlisted, 2, "2 URLs matched and set");
  assert.equal(r1.cleared, 1, "the one other domain property (C) is cleared");
  assert.deepEqual(r1.unknown, [], "no unknown URLs in a clean run");
  let state = flags();
  assert.equal(state.find((p) => p.id === "propA")!.d, 1, "A is shortlisted");
  assert.equal(state.find((p) => p.id === "propB")!.d, 1, "B is shortlisted");
  assert.equal(state.find((p) => p.id === "propC")!.d, 0, "C (not in the new list) is cleared to 0");
  assert.equal(
    state.find((p) => p.id === "propRea")!.d,
    null,
    "the REA property is untouched -- it is not Domain-sourced",
  );

  // --- does NOT touch shortlist_tag (A starts null, this is what would go
  // "maybe" if setDomainShortlist ever confused the two columns) ---
  assert.equal(state.find((p) => p.id === "propA")!.t, null, "shortlist_tag on A is untouched (still null)");
  assert.equal(state.find((p) => p.id === "propC")!.t, "rejected", "shortlist_tag on C is untouched even when cleared");

  // --- idempotent: running the same list again changes nothing ---
  const r2 = setDomainShortlist([URL_A, URL_B]);
  assert.equal(r2.shortlisted, 2, "second identical run still reports the same 2 matched");
  const stateAfterRepeat = flags();
  assert.deepEqual(stateAfterRepeat, state, "re-running the same shortlist leaves every row identical");

  // --- switching the list: previously-shortlisted A drops out, C comes in ---
  const r3 = setDomainShortlist([URL_C]);
  assert.equal(r3.shortlisted, 1, "1 URL matched");
  assert.equal(r3.cleared, 2, "the two properties no longer in the list (A, B) are cleared");
  state = flags();
  assert.equal(state.find((p) => p.id === "propA")!.d, 0, "A dropped out of the shortlist");
  assert.equal(state.find((p) => p.id === "propB")!.d, 0, "B dropped out of the shortlist");
  assert.equal(state.find((p) => p.id === "propC")!.d, 1, "C is now shortlisted");
  assert.equal(state.find((p) => p.id === "propRea")!.d, null, "REA property still untouched");

  // --- unknown URLs come back in `unknown`, and do not throw ---
  const r4 = setDomainShortlist([URL_C, URL_UNKNOWN]);
  assert.equal(r4.shortlisted, 1, "only the real URL is counted as shortlisted");
  assert.deepEqual(r4.unknown, [URL_UNKNOWN], "the unmatched URL is reported, not silently dropped");

  // --- sec-001: a NON-EMPTY list where NOTHING matches must NOT fall through
  // to the unconditional clear-all -- that would silently wipe every Domain
  // property's shortlist flag on a bad/mistyped URL list. C is shortlisted
  // (1) from r3 above; it must stay that way. ---
  const r4b = setDomainShortlist([URL_UNKNOWN]);
  assert.equal(r4b.shortlisted, 0, "no URL matched, so nothing is shortlisted");
  assert.equal(r4b.cleared, 0, "an all-unknown list must not clear anything");
  assert.deepEqual(r4b.unknown, [URL_UNKNOWN], "the unmatched URL is still reported");
  assert.equal(
    (sqlite.prepare("SELECT domain_shortlisted d FROM properties WHERE id = ?").get("propC") as { d: number }).d,
    1,
    "C's shortlist flag must survive an all-unknown call untouched",
  );

  // --- an empty list clears every domain-sourced property, throws on nothing ---
  const r5 = setDomainShortlist([]);
  assert.equal(r5.shortlisted, 0, "empty list shortlists nothing");
  assert.equal(r5.cleared, 3, "every domain-sourced property (A, B, C) is touched by the clear");
  assert.deepEqual(r5.unknown, [], "empty input reports no unknowns");
  assert.equal(
    (sqlite.prepare("SELECT domain_shortlisted d FROM properties WHERE id = ?").get("propC") as { d: number }).d,
    0,
    "C is cleared by an empty shortlist",
  );

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ shortlist.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ shortlist.test FAILED:", e);
  process.exit(1);
});
