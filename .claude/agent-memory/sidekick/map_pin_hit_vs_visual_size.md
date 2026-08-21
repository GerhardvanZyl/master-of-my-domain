---
name: map-pin-hit-vs-visual-size
description: MapView pin's button (hit area, floored at 24px) is a different element from the inner span (visual dot, the true 5-50px vibe-scaled diameter) — test the span, not the button, for size assertions
metadata:
  type: project
---

`src/components/MapView.tsx`'s map pin is two nested elements with different
sizes:

- `<button data-testid="map-pin">` — the tap target. Its `width`/`height` is
  `hit = Math.max(d, PIN_HIT_MIN)` where `PIN_HIT_MIN = 24`, so it never
  reflects [[pin-scale.ts's]] actual 5-50px range once `d` drops below 24.
- The `<span>` inside it — the visible dot, styled `width: d, height: d`
  directly from `pinDiameter()`. This is the element that carries requirement
  5's stated bounds (min 5px, max 50px).

**How to apply:** any test asserting on rendered pin *size* (as opposed to
locating/clicking pins, which should stay on the button) must read
`button[data-testid="map-pin"] > span`'s `getBoundingClientRect()`, not the
button's. Reading the button's width will pass even with the scaling
completely broken, because it's floor-clamped to 24px regardless of `d`.

See [[shared_property_filter_module]] for the sibling MapView/PropertyGrid
convention this test lives next to (`test/ui.test.ts`'s `map` section).
