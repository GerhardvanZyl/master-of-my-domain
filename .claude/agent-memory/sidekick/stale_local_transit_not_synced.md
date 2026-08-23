---
name: stale-local-transit-not-synced
description: local app.db can hold a genuinely-measured pt_minutes_to_flinders for a row the live app reports as null; check before running the estimator over it
metadata:
  type: project
---

`scripts/_transit-estimate.ts`'s "measured pool" (`known`) always scans the
full local `data/app.db`, even when `NEED_JSON` scopes which rows to fill. If
one of the rows named in `NEED_JSON` already has a non-null,
non-"Estimated"-prefixed `pt_minutes_to_flinders` locally, the estimator
matches that row against itself (distance ~0m) and wraps a note like
"Estimated from nearest tracked property (<same address>, ~0 m away): <the
real measured text>" — self-referential and wrongly marked as an estimate.

Found on 2026-08-23: 7 Mowbray Drive, Point Cook had a real measured transit
answer in local `app.db` (`updated_at` 2026-08-14, `pt_steps` not prefixed
"Estimated") that had simply never made it to the live app. Before pushing the
estimator's output for a row, grep the local DB directly for that address's
`pt_minutes_to_flinders`/`pt_steps` — if it's already a genuine measurement,
push that verbatim instead of the self-referential estimate text.

**Why:** the UI's `*` marker is driven purely by the "Estimated" prefix on
`pt_steps` (see [[update-properties-procedure]] step 6); pushing a
self-referential wrapper both mislabels a real measurement as an estimate and
reads as nonsense to a human ("estimated from itself, 0m away"). **How to
apply:** whenever filling `nearestStation`/`ptMinutesToFlinders` gaps on live
via the estimator, spot-check each `~0 m away` match in its output against the
local DB row directly before pushing.
