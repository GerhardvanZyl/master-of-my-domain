---
name: map-view-region-scoping
description: /map and /sydney/map are now separate single-region routes; MapView takes a `region` prop and reads one filter key — the old dual-region reading was deleted 2026-08-21
metadata:
  type: project
---

Superseded design (kept for history): `/map` used to show both VIC and NSW
pins on one page while `PropertyGrid`'s filter persistence is region-scoped
(`filters:${region==="vic" ? "" : region+":"}${profile}` in
`src/components/PropertyGrid.tsx`), so `MapView` read BOTH region-scoped
localStorage keys and split pins on `p.state === "NSW"` to apply each.

That was deliberately deleted in the `feat/map-region-and-panzoom` branch. Now:

- `MapView` takes a `region: string` prop and reads exactly one filter key via
  `loadRegionFilters(region, profile)` — no state-based splitting inside the
  component at all.
- `src/app/map/page.tsx` → `listProperties().filter(p => p.state !== "NSW")`,
  `<MapView region="vic">` — mirrors `src/app/page.tsx` exactly.
- `src/app/sydney/map/page.tsx` (new) → NSW only, `<MapView region="nsw">` —
  mirrors `src/app/sydney/page.tsx`.
- Neither map route is in `NavLinks` beyond the existing `/map` entry;
  `/sydney/map` is direct-navigation only, same as `/sydney` itself.

If you see the old dual-region-key description elsewhere (docs, an old
walkthrough), it's describing the pre-2026-08-21 behavior — trust the current
`MapView.tsx` signature over it.

See [[shared-property-filter-module]] for the filter predicate module both
`PropertyGrid` and `MapView` still share.
