---
name: propertygrid-avoid-per-row-hooks
description: PropertyGrid.tsx (~290 rows) is explicit about avoiding per-row hook instances/state; pattern for giving a shared component an optional prop with a hook fallback without violating rules-of-hooks
metadata:
  type: project
---

`src/components/PropertyGrid.tsx` renders ~290 property tiles/rows and has
existing comments explicitly calling out "avoid ~290× work" — it hoists
state that would otherwise be per-row (e.g. `profile` from `useProfile()`)
to the top level and passes it down as a prop (`canVibe={!!profile}` etc.)
rather than letting each tile mount its own hook (extra `useState` +
`window` listeners × ~290).

**Why:** confirmed via a reviewer brief on the share/inbox feature — flagged
`ShareButton` calling `useProfile()` once per grid row as a real perf issue,
not a nitpick.

**How to apply:** when a shared component (e.g. `ShareButton.tsx`) needs a
value from a hook but is also mounted in bulk from `PropertyGrid`, give it an
optional prop for that value and only fall back to the hook when the prop is
`undefined`. You cannot conditionally call a hook inside one component body
(rules-of-hooks) even if the branch is stable per call site — split into a
prop-driven "base" component (no hooks) plus a thin wrapper component that
calls the hook and forwards the result; the wrapper is a plain function
component that decides *which child to render*, not a hook call itself, so
each of the ~290 grid instances that pass the prop never mounts the
hook-using wrapper at all. See `src/components/ShareButton.tsx` for a worked
example (`ShareButton` → `ShareButtonWithHook` / `ShareButtonInner`).
