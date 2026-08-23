---
name: ui-test-stale-behavior-assertions
description: test/ui.test.ts can contain a test asserting the OLD behavior a brief is deliberately changing — grep for the feature name across ui.test.ts, not just unit tests, before calling a change done
metadata:
  type: feedback
---

When a brief changes intended behavior (not just fixes a bug), `test/ui.test.ts`
may have an end-to-end test that hard-asserts the pre-change behavior as
correct. Example: the property.com.au fallback-link brief (2026-08-23) said
"always render the row" — but `test/ui.test.ts` had
`detail page shows no year-built row or property.com.au link when both are
NULL`, which asserted the row's absence. `npm test` (unit tests only) stayed
green while this ran; only `npm run test:ui` caught it, as a new failure beyond
the two pre-existing mobile-text-wrap failures.

**Why:** `npm run test:ui` is comparatively slow/manual, so it's tempting to
treat unit-test green as "done." A stale e2e assertion doesn't fail loudly as
"wrong" — it fails as an unrelated-looking new UI test failure, easy to
misread as a regression you introduced rather than a test that needed updating
to match the brief.

**How to apply:** whenever a brief changes what a component renders/does (not
adding a net-new feature), `grep -n` the feature's name/label text in
`test/ui.test.ts` before declaring the change done, and update any assertion
of the old behavior in the same pass. Compare the final `test:ui` pass/fail
count against the brief's stated baseline (e.g. "52 passed, 2 failed, both
pre-existing") rather than eyeballing the log.
