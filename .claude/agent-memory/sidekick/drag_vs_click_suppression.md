---
name: drag-vs-click-suppression
description: MapView's drag-vs-click suppression — capture pointer only once a drag is detected (not on pointerdown, which swallows every click), plus the pointercancel-with-no-click edge case
metadata:
  type: project
---

Pattern used for MapView's pan/zoom (added `feat/map-region-and-panzoom`,
2026-08-21, fixed 2026-08-21), reusable anywhere a draggable surface contains
clickable children (pins are `<button>`s that `router.push()`):

- **`setPointerCapture` on pointerdown unconditionally is WRONG and was shipped
  once, then fixed.** The original assumption — "pointer capture retargets
  pointermove/pointerup but not the synthetic click" — is backwards. Verified
  empirically in headless Chromium: with capture active at pointerup, the
  resulting `click` retargets to the CAPTURING element, not whatever is
  visually under the pointer, so a captured child `<button>`'s own `onClick`
  never fires at all, drag or not. Repro: pointerdown+setPointerCapture on a
  container with a child button, then a plain click-no-move sequence — the
  child's click listener is silent; only the container's fires.
- The fix: capture only once a real drag is detected — take it in
  `pointermove` at the moment movement crosses `DRAG_SLOP` (not in
  `pointerdown`), and `releasePointerCapture` in the shared end-of-gesture
  handler (`onPointerUp`/`onPointerCancel`). A plain click then never involves
  capture at all, so the child's `onClick` fires normally; a real drag still
  gets capture for the rest of its gesture (needed so panning keeps tracking
  once the pointer leaves the element).
- A movement threshold (`DRAG_SLOP`, 6px here) gates when a
  pointerdown→pointermove sequence is *counted* as a drag at all — below it,
  the natural jitter of a real click is preserved and the click fires. At or
  above it, a `draggedRef` ref flips true (and capture is taken, per above).
- The actual suppression is an `onClickCapture` on the **container**
  (capture-phase fires root→target, ahead of any descendant's bubble-phase
  `onClick`) that calls `e.stopPropagation()` + `preventDefault()` and clears
  the ref when `draggedRef.current` is true. This blocks the descendant's
  `onClick` regardless of which element the click's target actually is —
  don't try to solve this per-button; one capture-phase guard on the
  container covers all children.
- `draggedRef` is intentionally left `true` from the moment the drag threshold
  is crossed through the `pointerup` — it's the click that follows pointerup
  (not the pointerup itself) that needs to be swallowed, so clearing it in
  the pointerup handler is too early.
- **But a drag's pointerup does not always produce a following click at all**
  (confirmed: a gesture ended via `pointercancel` instead of a click-producing
  `pointerup` releases capture with zero click ever firing), so relying solely
  on `onClickCapture` to clear `draggedRef` leaves it permanently armed after
  such a gesture and silently swallows the very next unrelated click. Fix:
  also reset `draggedRef.current = false` at the top of `onPointerDown`, so
  the flag can never outlive the gesture that set it — the `onClickCapture`
  clear remains the normal-path clear, this is just the safety net.
- Testing a click-less drag end in Playwright requires more than
  `mouse.down()`/`move()`/`up()` — Chromium always synthesizes exactly one
  `click` from a real mousedown/mouseup pair, retargeted to whichever element
  holds capture, no matter where release happens. To genuinely produce zero
  clicks: do a real drag past `DRAG_SLOP` (so real capture is taken), then
  `element.dispatchEvent(new PointerEvent("pointercancel", { pointerId }))` —
  a synthetically-dispatched event still invokes the real registered handler,
  and if that handler calls the real `releasePointerCapture()` API, capture is
  genuinely released — then move the mouse away from the container before the
  real `mouse.up()`, so the resulting click lands nowhere near it.
  Also: `setPointerCapture` throws `InvalidPointerId` if the pointerId wasn't
  from a real, currently-active pointer — an all-synthetic pointerdown+move+
  cancel sequence (no real mouse involved) throws on the app's own capture
  call, so the setup portion of a repro like this needs a real `page.mouse`
  gesture, not a fully synthetic one.

Also: React's `onWheel` (and touch) listeners are attached **passive** by
React itself — `e.preventDefault()` inside a React `onWheel` handler is a
silent no-op (no error, just doesn't work). To actually block the page
scrolling under a wheel-zoom, attach a native `addEventListener("wheel", fn,
{ passive: false })` in a `useEffect`, not a JSX `onWheel` prop.

A separate blind spot bit the plain-click test itself (found in verification,
2026-08-21): "clicking a pin without dragging still navigates" originally did
`mouse.move` (no movement) → `down()` → `up()`, with zero movement between
down and up. `handlePointerMove` never fires at all in that sequence, so
`DRAG_SLOP` is never exercised in the direction it exists for — deleting the
`DRAG_SLOP` line entirely survived the whole suite. Fix: move the mouse a
couple of px (e.g. `hypot(3,2) ≈ 3.6px`, comfortably under 6px) between
`down()` and `up()` in that test, so it proves a real click's inevitable
jitter still fires `onClick` — not just that zero movement does.
