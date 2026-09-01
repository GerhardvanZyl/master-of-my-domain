---
name: transient-vs-permanent-cache-miss
description: geocode-missing.ts pattern for keeping a curl-retry-exhausted failure out of a consult-before-request cache, contrasted with overpass-poi.ts's throw-on-failure
metadata:
  type: project
---

`scripts/geocode-missing.ts` (like `scripts/lib/overpass-poi.ts`) shells out to
curl with retries, then persists an outcome to a JSON cache that is consulted
*before* the next request — so any cache write for a key is effectively
permanent unless someone hand-edits the file.

Two failure classes must never share a cache shape:
- A **genuine answer** (a coordinate, or a confident low-confidence rejection)
  is cacheable — the source actually responded.
- A **transient failure** (retries exhausted: network down, curl missing,
  timeout, malformed JSON) is NOT cacheable — the source never answered, so
  there is nothing to remember, and caching it as a miss silently makes the
  row unfixable without a manual cache edit.

`overpass-poi.ts`'s `getPois()` handles this by throwing and aborting the
whole run rather than writing a placeholder. `geocode-missing.ts` chose the
other valid option instead (given a brief that named both and asked for a
justified choice): continue processing remaining rows at 1 req/s, skip the
cache write for that one row (so it's retried next run), and print failures
in a separate bucket from misses in the summary output — a large batch
shouldn't die on one flaky row, but "some rows failed and were silently
counted as done" is worse than either alternative, so failures must be
visibly distinct from misses in the output, not folded into a single count.

Extracted seam for testing this without mocking curl: a pure function from
`{kind: "resolved", coord} | {kind: "transient-error", message}` to
`CacheEntry | null` (null = don't touch the cache). Proves "transient failure
never produces a cache entry" and "the row's key stays absent, hence eligible
for retry" without needing to run main() or fake a curl process.

**How to apply:** any future curl-backed cache-before-request script in this
repo should keep failure and rejection as distinct states from the start —
retrofitting it after a review round (as here) means also fixing the summary
output and adding a dedicated regression test, not just the cache-write line.
