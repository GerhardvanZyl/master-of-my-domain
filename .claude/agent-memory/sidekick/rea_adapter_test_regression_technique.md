---
name: rea-adapter-test-regression-technique
description: how to prove a "regression test would have caught this" claim for src/scrape/adapters/rea.ts hero/cover-ordering fixes
metadata:
  type: project
---

For `src/scrape/adapters/rea.ts`, the hero/cover ordinal is picked by
reordering an already-deduped candidate list (`byHash`/`hashOrder`), not by
adding a new candidate. A regression test for "X should become the cover"
only fails pre-fix if the candidate list has **more than one** image whose
natural first-seen order differs from X — a single-image payload passes
trivially both before and after the fix and proves nothing.

**Why:** caught during the 2026-08-31 og:image widening brief — an initial
version of the "no Event block" test used only one candidate URL and could
not have failed pre-fix; had to add a second, earlier-ordered decoy image so
the ordinal-0 assertion actually depended on the fix.

**How to apply:** when writing a would-have-been-bug regression test for
ordering/priority logic in this adapter (or similar dedupe+reorder code
elsewhere), include at least two candidates and assert on relative order, not
just presence/count. Confirm failure by temporarily reverting only the
targeted line and re-running before restoring it — cheap and catches this
class of false-positive test.
