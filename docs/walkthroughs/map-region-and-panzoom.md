# Walkthrough: map region split + drag-to-pan / wheel-zoom

**Branch:** `feat/map-region-and-panzoom` · **Diff base:** `f5a13b1` · **Commit:** none yet —
written against the uncommitted working tree. Anchors below are file+line as the files
currently sit on disk, not against a commit hash; they will hold once this lands as a commit.

Three things land together: `/map` shows Melbourne (VIC) properties only; NSW properties get
their own route at `/sydney/map`; and the map is now interactive — drag to pan, scroll wheel to
zoom, both toward the cursor.

**Out of scope:** touch input as a dedicated feature — no pinch-zoom, no touch-specific handling
was built. The requirement named mouse and scroll wheel only. That does not mean the map behaves
the same on a phone, though: see "Not covered" further down for what `touch-none` and the
type-agnostic pointer handlers actually do there. No nav entry for `/sydney/map`, matching
`/sydney` itself, which has never had one.

## Architecture

```mermaid
flowchart LR
    subgraph VIC["/map"]
        MapPage["src/app/map/page.tsx"] -->|properties, region="vic"| MV[MapView]
    end
    subgraph NSW["/sydney/map — new"]
        SydMapPage["src/app/sydney/map/page.tsx"] -->|properties, region="nsw"| MV
    end
    MV -->|loadRegionFilters(region, profile)| LS[(localStorage, written by PropertyGrid)]
    MV --> Tiles[OpenStreetMap tile server]
    MV --> Pins["pins: PropertyListItem[]"]
    Pins -->|router.push| Detail[Property detail page]
```

One `MapView` component, now parameterised by a `region` prop instead of reading both regions'
filter keys itself. The two page files are the only things that differ between the routes —
each filters `listProperties()` by state and hands `MapView` one region's slice, exactly the
shape `src/app/page.tsx` / `src/app/sydney/page.tsx` already use for the grids.

## Sequence — a drag that ends on a pin

```mermaid
sequenceDiagram
    participant User
    participant Box as map box (onPointerDown/Move/Up, onClickCapture)
    participant Pin as pin button (onClick to router.push)

    User->>Box: pointerdown (over a pin)
    Box->>Box: draggedRef = false; record startClientX/Y, startView
    User->>Box: pointermove (past DRAG_SLOP)
    Box->>Box: setPointerCapture(pointerId); draggedRef = true; setView(panned)
    User->>Box: pointerup (still over the pin)
    Box->>Box: releasePointerCapture; draggedRef stays true
    Box->>Box: click bubbles → onClickCapture fires FIRST (capture phase)
    Box->>Box: draggedRef true → preventDefault() + stopPropagation(); draggedRef = false
    Note over Pin: Pin's own onClick never runs — no navigation
```

## Change table

| File | Change | Notes |
| --- | --- | --- |
| `src/app/map/page.tsx` | Filters to `p.state !== "NSW"`, passes `region="vic"` | Was `<MapView properties={listProperties()} />` with no region at all |
| `src/app/sydney/map/page.tsx` | New. Mirrors `src/app/sydney/page.tsx`: filters `p.state === "NSW"`, `region="nsw"` | |
| `src/components/MapView.tsx` | Dual-region filter reading deleted; `region` prop added; drag-pan, wheel-zoom, finiteness guards, per-region fallback centre added | The whole change lives here |
| `test/ui.test.ts` | New drag/wheel/region tests; existing dual-region filter test rewritten for the single-region read | |
| `.claude/agent-memory/sidekick/map_view_region_scoping.md` | Updated to record the single-region shape | Agent memory, not application code — ignore for review purposes |

## The flow

| Entrypoint | Trigger | First changed file it reaches |
| --- | --- | --- |
| `GET /map` | Browser navigation | `src/app/map/page.tsx` |
| `GET /sydney/map` | Browser navigation | `src/app/sydney/map/page.tsx` (new) |
| Mouse drag / wheel over the map box | Browser pointer/wheel events | `src/components/MapView.tsx` |

### Thread 1 — this change deletes complexity, it does not add it

The previous run's `MapView` read **both** region-scoped filter keys and split the incoming
properties on `p.state === "NSW"` internally, applying each region's saved filters to its own
half so one map page could show both cities filtered independently. That was flagged in the
previous walkthrough's open questions as an interpretation taken on the user's behalf, not
something requirement 4 actually specified — carried forward rather than resolved.

The user resolved it: NSW should not appear on `/map` at all. It gets its own route. **So this
change removes the dual-region reading rather than extending it.** `MapView` (`MapView.tsx:76-82`)
now takes a plain `region: string` prop and calls `loadRegionFilters(region, profile)` once
(`MapView.tsx:109-112`) — one filter key, one properties array, no internal split. The open
question closes because the code got simpler, which is the outcome worth having: a reviewer
checking this diff should see logic disappearing from `MapView`, not a new branch added to the
old dual-region logic.

### Thread 2 — why `/sydney/map`, not `/map?region=nsw`

`src/app/page.tsx` already documents the convention this mirrors:

> `// ponytail: root = Melbourne (VIC), /sydney = NSW. Split by state, not a`
> `// suburb allowlist — add a region param if a third city ever shows up.`

`/` filters `p.state !== "NSW"` with a VIC grid; `/sydney` filters `p.state === "NSW"` with an
NSW grid. Region is a property of the *route*, not runtime state inside one route. `/sydney/map`
(`src/app/sydney/map/page.tsx:1-9`) mirrors that exactly, so this isn't a new idea — it's the
existing convention extended to the map. The rejected alternative, `/map?region=nsw`, would have
kept region as a query param inside a single route and, worse, would have preserved the one
thing this change exists to remove: a component reading two regions' filter keys at once.
`/sydney` has never had a `NavLinks` entry, so `/sydney/map` needing none either is consistent
with that, not an oversight.

### Thread 3 — the view model, and the rejected shape that would have silently broken auto-fit

`MapView.tsx:152-178` (`autoView`) computes the largest integer zoom where every pin fits, and is
a **live `useMemo`**, not a value captured once. `MapView.tsx:184-185` layers `view: ViewState |
null` on top: `null` means "the user hasn't touched the map yet," so `effectiveView = view ??
autoView` renders the live auto-fit until the first drag or wheel event, at which point `view`
takes over and stops moving on its own.

The alternative — seed `view` from `autoView` on mount and always treat it as set — was rejected
because it would have **frozen the camera at mount time**. With the current shape, a user who
toggles a filter chip before ever touching the map still gets re-centred on whatever pins remain,
because `autoView` keeps recomputing. Seeding at mount would have quietly lost that behaviour,
and nothing in the requirement or the existing tests would have caught the regression — it's the
kind of thing that only shows up as "why did the map not move when I filtered" days later.

A second alternative — keep the old `zoomAdj` number and add a separate `panOffset` — was also
rejected, for a more structural reason: it splits one camera into two overlapping state variables
with no defined precedence once both are non-zero. `ViewState { z, originX, originY }` is one
value with one owner.

### Thread 4 — drag-suppression, and the click that stopped firing entirely

`MapView.tsx:203-281` is the pan/click-suppression machinery: `handlePointerDown`,
`handlePointerMove`, `endDrag`, `handleClickCapture`. Read this section knowing it was built,
broken, and fixed once already before this walkthrough was written — see Decisions below, this
is the section worth reading most carefully.

### Thread 5 — zoom is stepped, not continuous, as a proportionality call

The requirement asked for the interaction to feel continuous. This is *not* because a fractional
zoom would misalign tiles and pins — tiles and pins are placed by the same `project(z)`
(`src/lib/mercator.ts`, unchanged), and rendering the tile layer at `floor(z)` scaled by
`2 ** (z - floor(z))` keeps the two in step at any fractional zoom, which is exactly how
pinch-zoom works in every raster map library. Nothing about OpenStreetMap's integer-zoom tiles
makes a fractional `z` impossible here.

Zoom level stays an integer anyway, because a fractional-zoom transform layer was more machinery
than this requirement justified — a proportionality call, not a technical constraint. What was
made continuous instead is the *response* to input: `MapView.tsx:293-335`'s wheel handler
normalises `deltaMode` and accumulates `deltaY` into `wheelAccum`, consuming it a whole
`WHEEL_STEP = 120` at a time and carrying the remainder, so a single mouse-wheel notch (which
reports ~100-120 in one event) steps once immediately, while a trackpad's many small per-swipe
deltas accumulate to the same step over a few events — one input path, both feel right, one
integer `z` underneath both, and zoom-toward-cursor exact regardless.

## Decisions

### Drag-suppression — capture on detected movement, not on pointerdown

- **Decided:** `handlePointerDown` (`MapView.tsx:226-240`) never calls `setPointerCapture`.
  Capture is taken inside `handlePointerMove` (`MapView.tsx:254-257`) only once movement passes
  `DRAG_SLOP = 6`px — the point a gesture is genuinely a drag rather than click jitter.
- **Why this had to change from the first draft, not just get more tests.** The first
  implementation captured the pointer on every `pointerdown`. That meant every pin click
  navigated nowhere: when pointer capture is active at `pointerup`, the browser dispatches the
  resulting `click` to the *capturing element* (the map box), not the element under the cursor —
  so the pin `<button>`'s own `onClick` never runs, drag or not. The original code comment
  asserted the opposite; it was wrong, and it shipped once inside this run before being caught.
- **This was found by the tests, and specifically by the test that wasn't about dragging.** All
  three drag-suppression tests passed against the broken version — "a drag must not navigate"
  is trivially true when *nothing* navigates. It was the complementary test, "a plain click still
  navigates," that failed and exposed the defect. Confirmed against real headless Chromium with a
  standalone repro logging click targets on a container with a captured child button, not
  reasoned from the spec — the spec's own reasoning was what was wrong.
- **A reviewer reading this file should not need to re-derive this from the code**: the extensive
  comment block at `MapView.tsx:203-216` and `:65-71` records the empirical finding so nobody
  "fixes" it back to capturing on pointerdown believing that's more correct.

### `draggedRef` reset at gesture start, not just cleared on click — and a regression test that passed anyway

- **Decided:** `handlePointerDown` (`MapView.tsx:232`) sets `draggedRef.current = false` at the
  start of every gesture, in addition to `handleClickCapture` clearing it when a click is
  swallowed.
- **Why:** the flag was previously cleared only inside the click handler. A drag that ends via
  `pointercancel` (leaving the window, browser gesture interruption) rather than a
  click-producing `pointerup` never reaches that handler, so the flag stayed armed and silently
  ate the *next* genuine click — user-visible as "I panned the map, now clicking pins does
  nothing" until some unrelated click happens to clear it.
- **Worth flagging to a reviewer specifically: the first regression test for this passed with the
  bug still present.** A real mousedown/mouseup pair in Chromium always synthesises exactly one
  `click`, retargeted to the capturing element — so `onClickCapture` always got a chance to clear
  the flag regardless of what the fix did, and a naive "drag then click" test can never fail here.
  The test had to be rebuilt around a *real* drag past the slop threshold (so real capture is
  taken) ended by a genuinely dispatched `pointercancel`, which is the only path where no click
  follows at all — `test/ui.test.ts:840-897`. If you're asked to add coverage for a `draggedRef`-
  shaped flag anywhere else in this file, this is the trap: a click-based test proves nothing
  about the no-click path.

### Zoom stays integer; only the input response is continuous

Covered in Thread 5 above — recorded here because it's the kind of thing a reviewer who wanted
"continuous zoom" per the ticket wording might flag as a shortfall rather than a constraint.
`zoomFrom` (`MapView.tsx:191-196`) still clamps to the pre-existing `3..18` range and computes an
exact zoom-toward-cursor transform; only the *step size in z* is an integer, never the pan.

### `zoomFrom` stays a closure inside the component — rejected as a remedy, not disputed as a finding

Round 1 review raised `struct-001`: `zoomFrom` is a pure function that could be hoisted out of
`MapView` for direct unit testing, the same shape `pin-scale.ts` and `property-filters.ts` were
already extracted into. The observation itself isn't wrong — the repo has done this extraction
twice before. It was rejected as **not worth doing here**, not as incorrect: the evidence for the
pattern is inferred from two prior examples rather than a documented rule, and `zoomFrom` is
already exercised through the path a user actually takes — the wheel-zoom and clamp tests in
`test/ui.test.ts` drive it indirectly and would fail if it broke. Hoisting it now would add a
module and an import for coverage that already exists. If you're the reviewer and were about to
raise this again, it's already been weighed — see it as accepted-and-declined, not missed.

### `corr-001` — the region split turned a fine default into a wrong one

`autoView`'s no-coordinates fallback centre (`REGION_FALLBACK_CENTRE`, `MapView.tsx:60-63`) used
to be hardcoded to Melbourne CBD, which was a defensible generic default while one `MapView`
served both regions. This diff is what makes that wrong: on `/sydney/map`, with no NSW property
geocoded, the basemap would have rendered over Melbourne under its own "N properties have no
coordinates" notice — technically satisfying the edge case (nothing crashes, a basemap renders)
while showing the wrong city entirely. Fixed with a region-keyed lookup
(`REGION_FALLBACK_CENTRE[region] ?? REGION_FALLBACK_CENTRE.vic`, `MapView.tsx:158`) rather than a
single constant. Worth naming as a category, not just a one-off fix: any constant that was a fair
generic default while a component served every region becomes simply wrong the moment a route is
scoped to one region — worth a second look anywhere else this component (or one like it) still
carries a hardcoded default.

### `sec-001` — a non-finite view value would hang the tab, not crash it

The wheel accumulator's `while (wheelAccum >= WHEEL_STEP) { wheelAccum -= WHEEL_STEP }`
(`MapView.tsx:316-323`) never terminates if `deltaY` is `Infinity` — `Infinity - 120 === Infinity`
in IEEE-754 — and the same class of hole existed in the pointer-move handler via a non-finite
`clientX`/`clientY` feeding a non-finite tile-loop bound. Neither is reachable from real mouse or
trackpad hardware; both are reachable from a script already running in the page dispatching a
synthetic event, which is why the lane called it Major rather than Critical. Closed with one
guard applied at every `setView` call site — `isFiniteView` (`MapView.tsx:72-74`) — plus early
bails on non-finite `deltaY`/`clientX`/`clientY` at the point each is read, rather than one guard
per site that could be missed on the next addition.

## Where to look to review this

In priority order:

1. `src/components/MapView.tsx:203-281` — the drag/click-suppression state machine. This is
   where the two defects above lived; confirm the reasoning in the comments matches what you'd
   expect a real browser to do, since headless Chromium behaviour is doing real work here.
2. `src/components/MapView.tsx:152-185` — `autoView` / `view` / `effectiveView`, and why `view`
   is nullable rather than seeded at mount.
3. `src/components/MapView.tsx:60-63`, `:154-158` — `REGION_FALLBACK_CENTRE` and its use, the
   `corr-001` fix.
4. `src/components/MapView.tsx:65-74`, `:293-335` — `isFiniteView` and its call sites, the
   `sec-001` fix.
5. `src/app/map/page.tsx`, `src/app/sydney/map/page.tsx` — confirm both really are single-region
   now; this is the easiest place to spot if the dual-read had crept back in.
6. `test/ui.test.ts:840-897` — the `pointercancel` regression test; confirm it's actually
   exercising the no-click path and not the ordinary click path, per the trap noted above.

## Tests

`test/ui.test.ts` gained: a drag-pans test asserting pin displacement matches drag distance
(`:705-744`), two navigation-suppression tests for drags starting/ending on a pin
(`:751-794`), a plain-click-still-navigates test (`:800-815`) — the one that caught the
capture-on-pointerdown defect — the `pointercancel` regression test described above
(`:840-897`), two wheel-zoom tests — in/out (`:899-919`) and clamped-at-bounds (`:921-940`) — and
the `sec-001` non-finite-`deltaY` regression, which asserts the page is still responsive
afterwards rather than merely that it didn't throw (`:964-993`). One existing test — the
basemap-fallback regression for filters that exclude every property — had its filter-seeding step
rewritten (comment at `:646-651`) because it used to write both the vic and nsw `localStorage`
filter keys under the old dual-region reading; it now writes only the vic key, since writing an
nsw key would be dead code against the new single-region `MapView`. The two brand-new
region-identity tests (`:507-550`) assert pin *identity* (address parsed off each pin's `title`)
rather than a pin count, so an inverted region filter can't pass by coincidence of matching
totals.

Round 1 review (`dev-loop-lite`, one round, four lanes) raised 0 Critical, 1 Major (`sec-001`,
fixed), 2 Minor (`corr-001` fixed, `struct-001` rejected as a remedy call — see Decisions). No
escalation: the lite loop escalates only on a Critical in round 1, and there was none. The Tests
lane returned clean across six mutations, including a revert of the pointer-capture fix — the one
defect that had already shipped once earlier in this same run — which is why that clean result is
recorded here rather than passed over: this run produced two separate cases of a test suite that
looked complete and passed while the feature underneath it was broken, so a clean mutation result
carries more weight here than it would on a typical change.

**Not covered:** touch input as a dedicated feature, per the requirement's explicit
mouse/scroll-wheel scope — no pinch-zoom or touch-specific handling was built. That is not the
same as touch being inert, though, and the record should say so: `touch-none` is applied to the
map box, and pointer events fire for touch too — `handlePointerDown` only gates on `button` when
`pointerType === "mouse"`. So on a phone or tablet, today: single-finger drag now pans the map;
the browser's own pan and pinch-zoom over that 600px-tall element are suppressed as a side effect
of `touch-none`; pinch-zoom is therefore unavailable, so the `+`/`-` chips are the only way to
zoom there; and the page no longer scrolls when a finger starts on the map. This is the ordinary
slippy-map bargain, not a defect — but it is a real change to mobile behaviour and belongs here
rather than under a blanket "out of scope."

**Known pre-existing failures, unrelated to this change:** two `no squashed/over-wrapped text on
mobile` UI tests fail — data/font-driven, unrelated to anything in this diff. Do not chase them.

**Final validation, run on the finished tree:** `npx tsc --noEmit` clean; `npm test` green;
`npm run build` green, exit 0, with `/sydney/map` present in the route table — confirming the new
route actually builds, not merely type-checks; `npm run test:ui` 44 passed / 2 failed, both
pre-existing per the line above.

## Open questions

None outstanding for this change. The one open question from the previous run — whether `/map`
should apply each region's filters to its own subset of a combined view, or split by route
entirely — is what this change resolves; see Thread 1.
