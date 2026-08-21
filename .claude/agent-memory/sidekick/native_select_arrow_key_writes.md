---
name: native-select-arrow-key-writes
description: Native <select> elements consume arrow keys themselves when closed and focused; guard any select whose onChange writes data if it can share focus context with a global arrow-key handler
metadata:
  type: project
---

A closed, focused native `<select>` responds to arrow keys itself — on
Chrome/Windows, ArrowUp/ArrowDown AND ArrowLeft/ArrowRight all step the
selected option and fire `change`, before any `window`-level keydown handler
sees the event (the event still bubbles afterward — it isn't swallowed, so a
global handler on `window` still runs too).

**Why this matters here:** `src/components/TagSelect.tsx`'s `<select>`
PATCHes `/api/images/<id>/tag` immediately on `onChange` — no confirm, no
undo. `src/components/Lightbox.tsx` binds its own ArrowLeft/ArrowRight on
`window` for photo navigation. Before the fix, focusing the room dropdown and
browsing with arrow keys silently re-tagged photos while the UI looked like
normal navigation (the photo also advanced, via the same keypress bubbling to
window). Fixed by an `onKeyDown` on the `<select>` that `preventDefault()`s
the four arrow keys — this only blocks the closed-select native stepping;
once the dropdown is open (click, or Enter/Space/Alt+Down), the native popup
owns arrow keys itself and keyboard selection still works, since the popup
intercepts them before they reach the element's JS handlers.

**How to apply:** any future `<select>` (or similar native control) whose
`onChange` writes to the DB should get the same guard if it can appear inside
something that also listens for arrow/space/enter keys globally (lightboxes,
carousels, modal navigators). Don't fix this class of bug by adding a
focused-form-control guard to the *global* handler — that only stops the
*other* thing (e.g. photo nav) from also firing; it does nothing about the
native control's own default behavior, which is the actual write path. The
guard belongs on the control that owns the write.

See also [[ui_test_write_verification]] for how this was regression-tested.
