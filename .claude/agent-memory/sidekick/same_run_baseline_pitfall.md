---
name: same-run-baseline-pitfall
description: an "additive API response" test must diff against hardcoded expected types, not a same-run "before" snapshot from the same (possibly regressed) code
metadata:
  type: feedback
---

When writing a regression test for "response key X must keep its pre-existing
name/type," don't capture the "before" value by calling the same handler
earlier in the same test run and comparing types against that snapshot. If the
handler itself is uniformly mutated (e.g. a key's type changed everywhere, not
just in new code), both the "before" and "after" calls in the test run reflect
the same mutated code and the comparison passes anyway — a silent no-op guard.

**Why:** caught during mutation-testing `test/batch.test.ts` for the
2026-08-23 `/api/batch` `untaggedImages` addition — a `propertyComAuUrl:
String(propertyComAuUrl)` mutation passed a same-run baseline-typeof
comparison because the baseline was captured via the same mutated `GET()`.

**How to apply:** hardcode the expected type map (`{ ok: "boolean", properties:
"number", ... }`) from reading the source's documented/actual shape, and assert
against that literal instead of a same-run call. Re-verify by mutation-testing
the specific assertion, not just the block as a whole — a whole-file revert can
mask a per-assertion no-op that a narrower single-line mutation reveals.
