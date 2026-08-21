---
name: map-view-region-scoping
description: /map shows both VIC and NSW properties on one page, but PropertyGrid's filter persistence is region-scoped (separate localStorage keys) — anything reading grid filters from /map must restore both
metadata:
  type: project
---

`PropertyGrid`'s filter persistence key (`fkey` in `src/components/PropertyGrid.tsx`)
is `filters:${region==="vic" ? "" : region+":"}${profile}`, and there are two
grid instances: `/` (region="vic", `p.state !== "NSW"`) and `/sydney`
(region="nsw", `p.state === "NSW"`). `/map` (`src/components/MapView.tsx`) has
no region split of its own — one page shows both regions' pins together — so
anything on `/map` that wants to honour "the grid's filters" has to read BOTH
region-scoped localStorage keys and apply each to its own subset of
properties (split the same way page.tsx/sydney/page.tsx already do, via
`p.state === "NSW"`), not just the "vic" key. This isn't documented anywhere;
found by reading how `fkey` is built and where PropertyGrid is mounted.

See [[shared-property-filter-module]] for how the filter predicate itself was
extracted so both places use one definition.
