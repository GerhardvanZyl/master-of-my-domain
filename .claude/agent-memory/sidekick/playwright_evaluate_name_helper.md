---
name: playwright-evaluate-name-helper
description: page.evaluate() throws "__name is not defined" if the arrow passed to it holds a named const bound to a function and reused across handlers — tsx/esbuild's keepNames wraps it in a __name() call defined outside the shipped source slice
metadata:
  type: project
---

In `test/ui.test.ts` (and any other file run through `tsx`), a callback passed
to Playwright's `page.evaluate()` is serialized via the runtime function's own
source-text slice (V8's `Function.prototype.toString()`), then shipped to the
browser and `eval`'d there in isolation — nothing outside that slice comes
with it.

esbuild (which `tsx` uses to transpile) has `keepNames` behavior that rewrites
`const someHandler = () => {...}` into
`const someHandler = __name(() => {...}, "someHandler")` when that const is
later assigned to multiple places / reused as a value (e.g. `req.onsuccess =
someHandler; req.onerror = someHandler;`). The `__name` helper itself is
defined once at the top of the compiled file — outside the slice Playwright
ships to the browser — so the browser throws `ReferenceError: __name is not
defined` the moment the handler runs.

Symptom is silent at the call site: no TypeScript error, no lint warning, and
`fn.toString()` printed from Node looks the same. It only surfaces at
`page.evaluate` runtime, and only for callbacks that reuse a locally-named
function value.

Fix: don't hoist a shared handler into a `const` inside the evaluate closure —
inline separate anonymous arrows per handler instead (`req.onsuccess = () =>
resolve(); req.onerror = () => resolve();`), even if that means repeating the
same one-line body 3-4 times. Verified via `fn.toString()` printed
server-side before vs after: the `__name(...)` wrapper only appeared once a
named const was reused for `onsuccess`/`onerror`/`onblocked`/`setTimeout` in
`clearOutbox()`.

See [[ctx_setoffline_autoflush_race]] for another `test/ui.test.ts` timing/DOM
trap in the same offline-outbox test area.
