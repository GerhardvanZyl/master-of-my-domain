---
name: plain-assert-test-first-failure-only
description: this repo's test/*.test.ts files are plain top-level node:assert scripts that abort at the first thrown AssertionError, so adding several new "must fail before fix" assertions to the same file only proves the first one actually failed
metadata:
  type: project
---

`test/*.test.ts` files here are not run under a test framework (no Jest/Vitest
`it()` blocks) — they are plain scripts of top-level `assert.equal(...)` calls
executed with `tsx`. `assert.equal` throws and crashes the process on the
first failure, so if you add N new assertions in one file and revert the fix
to confirm they fail, running the file only shows you assertion #1's failure
message. Assertions #2..N never execute and you have not actually verified
them, even though the brief requires observing each one fail.

**Why:** a brief for `scripts/geocode-missing.ts` (2026-08-31,
`.claude/review/runs/2026-08-31-rea-geocode-lite/`) required reporting the
failure message for each of 4 new range/type-check tests. Running the whole
file pre-fix only surfaced the first (out-of-range latitude); the other three
were silently unverified until isolated.

**How to apply:** when a brief demands a failure message per new assertion and
there is more than one, write a small throwaway script (e.g.
`test/_tmp-iso.test.ts`, deleted before finishing) that imports the same
function and runs one assertion at a time (gate by `process.argv[2]`), against
the reverted pre-fix source. Restore the real source and delete the scratch
file before the final `npm test` run. See [[same-run-baseline-pitfall]] for a
related plain-assert-script trap (comparing against a same-run baseline
instead of a hardcoded expectation).
