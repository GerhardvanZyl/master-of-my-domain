---
name: map-view-pin-popup
description: MapView pin-click popup (hero/address/price) — design decisions and the closing-affordance convention split in this repo
metadata:
  type: project
---

Added in run `20260822-1330-feat-map-pin-popup` (branch `feat/map-pin-popup`):
clicking a `button[data-testid="map-pin"]` in `src/components/MapView.tsx` now
opens a `div[data-testid="map-pin-popup"]` (hero image via `imageUrl`, address,
`formatPrice`) instead of navigating immediately; clicking the popup navigates.

**Repo's overlay-dismissal convention is not single — it splits by shape:**
full-screen modals (`Lightbox.tsx`, `MapModal.tsx`, `CompareRooms.tsx`) use an
explicit `✕` button (`aria-label="Close"`) + a `keydown` Escape listener.
Small anchored popovers (`ShareButton.tsx`) use click-outside (`document`
`mousedown` + `ref.contains` check) + Escape, no visible button. The map popup
followed the modal convention (✕ + Escape), not the popover one, **deliberately**:
a `mousedown`/`click` document listener for "outside" detection has real
event-ordering hazards against MapView's own drag/click-suppression system
(see [[map_pin_click_path_fragility]]) — a `mousedown`-based listener fires
before a drag is confirmed (breaking "follows the pin while panning"), and a
bubble-phase `click` listener fires *after* a pin's own `onClick` in the same
event, so replacing the open pin and then immediately closing it in the same
click is a real risk, not a hypothetical one. Don't add click-outside to this
popup without re-deriving that interaction from scratch.

**Pan/zoom-while-open:** the popup's position is recomputed every render from
`effectiveView`/`project`/`pinScreenPos` exactly like a pin's own position, so
it "follows" the pin through pan and zoom for free — no extra state, no
listener. This was the cheaper option as well as the better UX one.

Popup layout constants (`POPUP_W=208`, `POPUP_MARGIN=8`,
`POPUP_MIN_SPACE_ABOVE=190`) live next to `DRAG_SLOP`/`WHEEL_STEP` in
`MapView.tsx`. Placement: horizontal is a plain clamp against `width`;
vertical flips above/below the pin based on a fixed height *ceiling* (image is
a fixed-height box + truncated single-line text, so 190px is a real ceiling,
not a guess) — never a measured DOM height.
