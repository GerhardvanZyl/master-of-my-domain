---
name: adapter-test-fixed-vs-relative-dates
description: test/adapters.test.ts mixes a fixed-capture fixture date (never update) with relative-to-Date.now() inspection-cutoff tests (must never be hardcoded literals)
metadata:
  type: project
---

`test/adapters.test.ts` has two different kinds of date assertion on
`nextInspection` that must NOT be written the same way:

- The REA fixture test (`reaFixtureRaw`, from `test/fixtures/rea-listing.json`)
  asserts a fixed literal (`2026-09-05T12:00:00+10:00`) because it's a real,
  frozen capture — that date is correctly hardcoded and must stay that way.
- Any test of the 6-hour-cutoff "next upcoming inspection" logic (in both
  `domain.ts`'s `nextInspection()` and `rea.ts`'s `earliestEventStart()`, which
  were made to match exactly on 2026-08-31 — see the accepted finding fixed
  that day) must build its `startDate`/`Event` timestamps as offsets from
  `Date.now()`, e.g. `new Date(Date.now() - 2*24*3600_000).toISOString()`. A
  hardcoded future literal silently becomes a past date later and the test
  stops proving anything.

**Why:** stated explicitly in the brief for the round-1 REA-adapter finding —
conflating the two styles either freezes a test that should track "now" or
unfreezes one that should stay pinned to a real capture.

**How to apply:** when adding/editing a `nextInspection` test in either
adapter, check whether the input is a real frozen fixture (keep the literal)
or synthetic cutoff-boundary data (build it off `Date.now()`). The 6h cutoff
boundary itself: a time within `Date.now() - 6*3600_000` is kept as "next"
(today's earlier slot stays visible); anything older is dropped.
