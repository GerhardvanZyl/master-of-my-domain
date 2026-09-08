---
name: project-delisted-derivation
description: How "delisted" is derived from alt_listing_url, and the marking hazard that makes a naive per-URL reading of the rule a regression
metadata:
  type: project
---

A property is delisted only when **every** listing URL it is known under is
delisted. The rule lives once, in `saleStatusOf` (`src/db/queries/properties.ts`),
which takes a `statusOf` lookup so `getSaleStatus` (one row) and `listProperties`
(one map for the whole grid) cannot drift. `alt_listing_url` carries the other
site's URL and is written only by a cross-source `twinMerge`.

**Why:** a house withdrawn from Domain but still live on realestate.com.au read
as delisted. User's rule, verbatim: "gap-fill while live, overwrite once
delisted — but as long as it's active on one source, it stays active in this app."

**How to apply:**

- **An unmarked URL defaults to LIVE, and that is the sharp edge.** Implementing
  the rule as derivation alone would make every row that has an
  `alt_listing_url` permanently non-delisted — a sold house would stay in the
  active grid — because nothing could ever mark the alt URL. `findProperty`
  (`src/db/queries/status.ts`) therefore also matches `alt_listing_url` and
  `setJobStatus` records against the URL the CALLER named, not the row's
  `listing_url`. Without that pair of changes the feature is a net regression.
  Do not "simplify" it back out.
- **The pipeline half is still open:** whether the REA round actually calls
  `markSold`/`markWithdrawn` with the REA URL is unverified. If it does not, a
  dual-listed house that sells reads as live until someone marks the alt URL.
  Check this before assuming the badge logic is wrong.
- Existing rows are unaffected: `alt_listing_url` is NULL for all 396 rows of
  the committed snapshot, so `saleStatusOf` degrades exactly to the old per-URL
  behaviour until a cross-source merge runs.
- `getSaleStatus` / `isDelisted` take a **row** (`{ listingUrl, altListingUrl }`),
  not a URL string. Deliberate: a required field makes the compiler catch every
  call site that forgets the alt.

Related: [[project-twin-merge-convergence]]
