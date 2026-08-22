---
name: map-pin-overlap-click-flakiness
description: Playwright locator.click() on a specific map pin (picked by address/DB query) can time out with "subtree intercepts pointer events" because Point Cook has many densely-packed/overlapping pins — click the DOM node directly instead
metadata:
  type: project
---

`test/ui.test.ts`'s map tests up to `feat/map-pin-popup` only ever did
`pins.first()` or a real mouse drag gesture — never "click the pin belonging to
a specific property I picked via a DB query". The moment a test needs that
(e.g. popup-content tests needing a property with/without a `thumbPath`),
`page.locator('button[data-testid="map-pin"]').nth(idx).click()` can hang for
the full 30s timeout with `element is not stable` / `<span> ... subtree
intercepts pointer events` from a *different* pin's title. At the map's default
(auto-fit) zoom, Point Cook alone plots hundreds of pins and some sit at
literally the same screen point (redacted "Address By Request" listings
appear to default to a shared/suburb-level coordinate) — Playwright's real
actionability check then routes the click to whichever pin's DOM node happens
to paint on top there, not the one you targeted.

**Fix used:** don't try to pick an "isolated" pin instead — that's fragile and
couples fixture selection to page geometry. Click the exact DOM node directly
via `locator.evaluate((el) => (el as HTMLButtonElement).click())` rather than
Playwright's mouse-driven `.click()`. This is safe specifically because these
popup tests (content, hero image, navigate, close, replace) never exercise the
drag/jitter pointer-capture path (see [[drag_vs_click_suppression]]) —
`draggedRef` is only ever armed by a real `pointerdown`→`pointermove`
sequence, which a native `.click()` never fires, so it's behaviourally
equivalent to a genuine no-jitter click for anything not testing drag
suppression itself. Tests that DO test the drag/jitter boundary (the jitter
test, the two "a drag ... does not navigate/open the popup" tests) must keep
using real `page.mouse` gestures — this shortcut is only for "click this known
pin and check what opens".
