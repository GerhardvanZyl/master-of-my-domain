---
name: scripts-dir-untested
description: scripts/*.ts and *.mjs have zero test coverage convention in this repo — no test/ file imports from scripts/, and both are unconditional-main() scripts
metadata:
  type: project
---

As of 2026-08-23, `test/` has no file that imports from `scripts/`, and
`package.json`'s `test` script never references `scripts/`. There is no
jest/vitest config either — the whole suite is plain `assert`-based scripts
run via `tsx`, registered as a `&&`-chain in `package.json`'s `test` script.

Several `scripts/*.mjs`/`*.ts` (e.g. `_tag-remote.ts`, `_groups-from-tags.mjs`)
call `main().catch(...)` unconditionally at the bottom of the file — importing
one for a test would immediately run it (network fetch to a live/LIVE_BASE
host, external vision-model calls, reads from `data/harvest/*` files that must
already exist). There's no `require.main`-style guard.

**How to apply:** when a brief asks for test coverage of a `scripts/` change,
do not invent an HTTP-mocking or module-extraction harness to reach it — the
project brief for the 2026-08-23 tagging-round-defects fix explicitly asked to
report "not covered, and why" rather than build one, and that matches the
observed convention (scripts are simply not part of the executable suite
here). If the *fix* logic is a genuinely trivial one-liner embedded in a loop
that also does model/fetch calls, extracting it into a pure function is a
bigger call than a sidekick should make silently — flag it back instead of
restructuring the script.

See also [[ui_test_write_verification]] for the parallel convention on the
`test/ui.test.ts` side (real server, not mocks).
