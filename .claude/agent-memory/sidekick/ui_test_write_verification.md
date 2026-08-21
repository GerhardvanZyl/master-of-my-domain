---
name: ui-test-write-verification
description: In test/ui.test.ts, prefer asserting on the network write itself (page.on("request")) over DOM state when a would-have-been-a-bug test needs to prove a write did/didn't happen
metadata:
  type: project
---

`test/ui.test.ts` is the plain-assert, no-framework Playwright suite (`t(name,
fn)` runner, own `next dev` against a VACUUM INTO copy of `data/app.db`). When
a regression test needs to prove a write happened or didn't (not just that the
DOM looks a certain way), the cheapest reliable signal is intercepting the
actual mutating request with `page.on("request", ...)` and matching the URL/
method, e.g. `PATCH` to `/api/images/<id>/tag`. This is stronger than reading
`select.inputValue()` alone: some components (e.g. `TagSelect`) don't reset
their internal React state when the underlying prop changes without a `key`
(navigating the lightbox to a new photo does NOT reset `TagSelect`'s `value`
state to the new photo's room — a separate, out-of-scope latent staleness bug
noticed 2026-08-20), so DOM value alone can be misleading; the network
assertion is unambiguous because the component's own `save()` is the only
write path.

For "does keyboard navigation move by exactly one step" assertions, don't
press keys that cancel out (e.g. ArrowLeft then ArrowRight nets to zero) in
the same block you're using to prove "the counter changed" — isolate the
net-zero stress keys (e.g. ArrowUp/ArrowDown, unbound to any navigation) from
the single directional key you assert actually moved something.

See also [[native_select_arrow_key_writes]] for the bug this pattern caught.
