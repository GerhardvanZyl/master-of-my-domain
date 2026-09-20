---
name: project-hero-and-floorplan-invariant
description: pickHero never reads `ordinal` — how the rendered hero is actually chosen, and why the floorplan scripts must resolve it with pickHero itself
metadata:
  type: project
---

`notes='hero'` and `notes='floorplan'` share one column, so any script that
writes a floorplan tag must first know which image the app leads with.

**Why:** a guard that excluded `ordinal === 0` "because for REA ordinal 0 IS
the hero" put `notes='floorplan'` on the image live was rendering as the hero
of `prop_927d99ebd31f`. The justification was false and had been sitting in a
comment in `scripts/_rea-floorplan-mark.mjs` for weeks.

**How to apply:**

- **`pickHero` (`src/lib/photo.ts`; `src/db/queries/properties.ts` re-exports
  it for existing callers) never reads `ordinal`.** Its
  rungs are: explicit `notes='hero'` → lowest `Image N` parsed from the **alt
  text** → lowest Domain CDN photoIndex among 3:2 shots → lowest-index real
  landscape → `imgs[0]`. REA writes `alt="Media Overview Image 2"` on the image
  at ordinal 1 and leaves ordinal 0 with **no alt at all**, so the alt rung puts
  ordinal 1 ahead of the true cover. Anything reasoning about "the cover" must
  call `pickHero` on the `isVisibleImage`-filtered array, not re-derive it.
- **Once you call `pickHero`, the old "skip a property with no explicit
  notes='hero'" rule is dead weight** — it existed only because the script could
  not tell which image was the hero. Excluding `pickHero`'s answer is sufficient
  *and* provably safe: a floorplan tag writes `notes='floorplan'` (never
  `'hero'`) and a non-`exclude` roomType, and `pickHero` reads only
  `roomType==='exclude'`, `notes==='hero'`, `alt`, `sourceUrl`, `width`,
  `height` — so the write cannot move its own answer.
- **`getLiveImages` (`scripts/_live-http.mjs`) already returns the
  `isVisibleImage`-filtered array** — it reads the flight stream of the page,
  and `getPropertyImages` filters server-side. Re-filtering is idempotent.
- **Shared code lives in two files split by runtime, on purpose.**
  `scripts/lib/floorplan-recover.ts` (hero split, classifier, buckets, tag row)
  is TypeScript using `@/*` path imports (it imports `@/lib/photo`, never
  `@/db/queries/properties`), so it can only be imported under `tsx`.
  `scripts/lib/floorplan-scan.mjs` (the `>Floorplan<` page sweep) is plain ESM
  so `scripts/_verify-live.mjs` can import it under bare `node`. The old
  justification — that `floorplan-recover.ts` opened and migrated
  `data/app.db` by importing `@/db/queries/properties` — no longer holds: that
  coupling was removed. Do not cite it as the reason, and do not merge the two
  modules; the runtime boundary above is reason enough on its own.
- **A failed classification is not "no floorplan exists".** `recoveryOutcome`
  splits `notClassified` (had candidates, none could be classified — just
  re-run) from `noCandidateStored` (looked at, genuinely none — the bucket
  `SKILL.md` tells the operator to STOP on and ask for a browser capture).

Related: [[repo-sqlite-scratch-and-db-hygiene]], [[project-delisted-derivation]]
