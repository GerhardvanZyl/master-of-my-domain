---
name: shared-property-filter-module
description: src/lib/property-filters.ts is the single definition of PropertyGrid's filter predicate, shared with MapView — narrowed to exclude sort/idealPrice, which don't affect set membership
metadata:
  type: project
---

`src/lib/property-filters.ts` holds the ~15 fields that decide which
properties a filter selection *keeps* (suburb, minBeds/Baths/Parking,
maxPrice, q, tagFilter, hideAuction/UnderOffer/Delisted, and the tri-state
inspecting/attended/viewed/rated/new chips), plus `parseFilterState` (the
back-compat localStorage parse) and `filterProperties` (the actual predicate).
`PropertyGrid.tsx` still owns all the `useState` hooks and the one
localStorage write (unchanged shape/key); it just calls the shared parser on
restore and the shared predicate inside its `view` useMemo instead of inlining
both. `MapView.tsx` only reads (via `parseFilterState`) — it has no filter UI
and never writes.

**Deliberately excluded:** `sort` and `idealPrice`. Neither removes a property
from the set — sort only reorders, idealPrice only feeds the vibe score — so
they stay local `useState` in PropertyGrid, same reasoning the original code
already applied to `mapSize`/`layout`/`pinned` as presentation-only. If a
future filter is added that also doesn't gate inclusion, keep it out of this
module for the same reason.

Predicate needs a few accessor functions it can't compute alone (a property's
attended/shortlist value may carry an unsaved optimistic edit in the grid, but
never in the map) — passed in via a small `FilterCtx` rather than baked in, so
PropertyGrid can overlay `vibeEdits`/`attendedEdits`/`shortlistEdits` and
MapView can just read the server row directly. `isRatedProperty` (also in this
module) takes an optional `myVibeOverride` for the same reason.

See [[map-view-region-scoping]] for why MapView has to read two localStorage
keys (one per region) to apply this predicate correctly.

**Known test coupling not fixed here:** `test/ui.test.ts`'s map test selects
pins via `button[title]:has(span:text("✨"))` — a leftover from the old
"price bubble" pin markup. The vibe-scaled circular-marker pins (5–50px
diameter, `src/components/MapView.tsx`) dropped that emoji span, so this
selector needs updating in the test pass that follows.
