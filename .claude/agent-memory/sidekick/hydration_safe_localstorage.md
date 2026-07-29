---
name: hydration-safe-localstorage
description: pattern this project expects for client components that read localStorage (used by PropertyPager) — read in useEffect, render null until then
metadata:
  type: project
---

Next.js App Router pages in this repo are server components; any component
needing `localStorage`/`window` must be a separate `"use client"` component,
and must read that state inside a `useEffect`, not during render — briefs are
explicit that hydration mismatches are a hard constraint. The established
pattern (see `src/components/PropertyPager.tsx`): `useState<T | null>(null)`
seeded from nothing, populate it in a `useEffect` with a try/catch around
`JSON.parse`, and `return null` from the component until the effect has run
and validated the data. Malformed/missing/invalid localStorage data should
make the component render nothing rather than an error or placeholder — no
loading skeleton needed for this class of component.

Also: `PropertyRail.tsx` (the right-rail editor) explicitly does NOT
re-sync local state from props after a save and does NOT call
`router.refresh()` — a comment in the file (`ponytail: no router.refresh() /
prop-sync effect after a write`) says a slow in-flight refresh could clobber a
newer local edit, since nothing else edits those fields. Follow this existing
optimistic-update pattern (`setState` immediately, then `fetch` PATCH, revert
only on error) for any new editable field added to that file — don't
introduce `router.refresh()` unless the file already uses it elsewhere.
