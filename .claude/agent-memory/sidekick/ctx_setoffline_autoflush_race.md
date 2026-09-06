---
name: ctx-setoffline-autoflush-race
description: ctx.setOffline(false) in test/ui.test.ts fires a real 'online' DOM event in Chromium, which SyncStatus auto-flushes on — racing a separately-registered waitForResponse
metadata:
  type: project
---

Verified live (small probe script): Playwright's `BrowserContext.setOffline(true/false)`
does dispatch real `offline`/`online` window events in Chromium (not just
`navigator.onLine`). `SyncStatus.tsx` listens for `online` and calls `sync()`
(which calls `flush()`) immediately.

Consequence for any offline/outbox test in `test/ui.test.ts`: if you call
`await ctx.setOffline(false)` as its own statement and only *afterwards*
register a `saved(page, () => clickSomething(), ...)` wait, the auto-flush can
already have completed (and hidden the SyncStatus pill, since it renders null
once `online && pending === 0`) before your listener attaches — the click
target (e.g. a `getByRole("button", { name: /to sync/ })` locator) then never
appears and the test times out with no other visible symptom.

Fix: make `ctx.setOffline(false)` itself the *action* passed into `saved()`,
so the response listener is registered before the toggle (and thus before the
online-triggered auto-flush) happens:

```ts
await saved(page, () => ctx.setOffline(false), /\/rating$/);
```

Don't click the SyncStatus pill as the trigger for a real online transition —
it's a valid trigger only when you're *already* online and manually retrying
(pending > 0, no automatic flush pending). See [[ui_test_stale_behavior_assertions]]
and [[same_run_baseline_pitfall]] for other timing traps in this suite.
