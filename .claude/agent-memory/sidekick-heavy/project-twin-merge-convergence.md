---
name: project-twin-merge-convergence
description: Why the twin merge gap-fills only for CROSS-source, live-canonical matches, what still oscillates, and which test encodes which rule
metadata:
  type: project
---

A house listed on both domain.com.au and realestate.com.au is merged onto one
row by `findTwinByAddress` (`src/scrape/persist.ts`). Two write paths reach that
merge: `loadProperties` (`src/db/queries/load.ts`) and `upsertProperty`
(`src/scrape/persist.ts`). `twinMerge` owns both rules and returns
`{ set, log }` — the columns to write and whether the caller logs changes.

**Why:** the merge used to overwrite unconditionally, which makes the row a
two-state oscillator and one phantom `property_changes` row per property per
sync round. Restricting it to gap-fill fixed that but froze a **same-source
relisting** — the old URL never returns in the feed, so the row kept the
withdrawn listing's price forever while `scraped_at` refreshed.

**How to apply:**

- **`findTwinByAddress` matches two genuinely different things and they need
  opposite treatment.** Cross-source (other site, same live listing) → gap-fill,
  no logging. Same-source (relisting under a new URL) → full overwrite, logging
  on. Any change here must keep both; a rule stated for "a twin" alone is wrong.
- **Cross-source gap-fill stops once the canonical URL is delisted** — nothing
  loads it any more, so nothing can flip a value back, and freezing would keep
  stale data the surviving listing could correct. That test uses the CANONICAL
  URL's own status, not the property-level one, or the rule cancels itself out.
- **Accepted cost, stated in the code:** two simultaneously live same-source
  listings for one house resume oscillating.
- **`test/ingest.test.ts` pins the same-source case** (`reloaded.beds === 5`
  after a `...-RELISTED` domain URL loads onto a domain row) and
  `test/changes.test.ts` pins the cross-source one (five identical rounds of a
  disagreeing dual-listed house = exactly ONE change row). They look like the
  same scenario and are not.
- **Residual oscillation, measured 2026-09-07 on a temp DB:**
  - `upsertProperty` REA-canonical + Domain twin supplying agent/agency: **9
    rows over 5 rounds** (2/round, one per divergent field). Unfixable at the
    write path — `src/scrape/adapters/rea.ts` writes explicit `null` into
    `NormalizedProperty` for every field it failed to find, so "not observed" is
    destroyed at the adapter. Recorded as a known limitation, not a bug to fix.
  - `loadProperties` leaked the same way only when an item carried an **explicit
    null**. Fixed at the CALLER (`scripts/_feed-load.ts` now sends `?? undefined`).
    Measured: `landSizeSqm: null` → 1,2,3,4,5; `undefined` → 1,1,1,1,1.

Related: [[project-delisted-derivation]], [[repo-sqlite-scratch-and-db-hygiene]]
