---
name: profiles-identity-source-of-truth
description: PROFILES in src/lib/profile.ts (hardcoded Gerhard + Johanita) is the ratified identity source, not property_ratings/DB-derived profiles — don't "fix" this back
metadata:
  type: project
---

`PROFILES` in `src/lib/profile.ts` is a hardcoded 2-entry array (`gerhard`,
`johanita`) and is the intentional source of truth for "who are the possible
users" anywhere the UI needs to list/pick a profile (e.g. `ShareButton`'s
"share with" list).

**Why:** an earlier brief for the share/inbox feature said to derive
recipient lists from the DB (`property_ratings`). A reviewer confirmed that
would be wrong: `property_ratings` only contains whoever has actually rated
something, so a fresh DB or a person who hasn't rated yet yields a one-entry
list and components like `ShareButton` silently render nothing. The
implementation correctly overrode that instruction and reused `PROFILES`.

**How to apply:** don't "fix" code that reads `PROFILES` back to a
DB-derived list — it's deliberate. If a future brief asks for DB-derived
profiles, flag this precedent rather than re-deriving.
