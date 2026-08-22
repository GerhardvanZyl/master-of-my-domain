---
name: photo-fixture-visibility-filter
description: When picking a property/photo fixture for a Lightbox/PhotoGrid UI test, the photo's on-screen position is the isVisibleImage-filtered index, not its raw ordinal
metadata:
  type: project
---

`getPropertyImages` (`src/db/queries/properties.ts`) orders by `images.ordinal`
then filters through `isVisibleImage` before Lightbox/PhotoGrid ever see the
array. Raw ordinal and on-screen index diverge whenever a photo gets dropped:
`roomType === 'exclude'` (agent headshots, logo cards — real listings carry
several, tagged by the local model with `notes: 'local:<model>'` or
`notes: 'rule:svg'`), or a non-floorplan/non-hero photo that fails the
`isPropertyPhoto` aspect heuristic (near-square 0.95–1.05, banner strips
≥2.2 or ≤0.45, or smaller than 500px on the long edge). A `notes: 'floorplan'`
or `notes: 'hero'` tag overrides the aspect check and keeps the photo visible
even if it's square — one real fixture had ordinal 0 as a 1080×1080 image
tagged `roomType: 'other', notes: 'floorplan'`, which stays visible.

**How to apply:** don't assume ordinal N is `button[title="Open"]:nth(N)`.
When a test needs "the Nth photo shown" or "two adjacent shown photos with
different rooms," replicate `isVisibleImage` (small, cheap to duplicate — see
`isVisibleImageLike` added in `test/ui.test.ts` for the TagSelect-remount
regression test) and filter/query at runtime against the tmp DB copy rather
than hand-picking a raw UUID + ordinal from a one-off inspection. Importing
`src/db/queries/properties.ts` directly into a test isn't an option either —
that module opens a real DB connection as an import side effect (`db` from
`../client`), which would defeat the whole point of `test/ui.test.ts` running
only against its throwaway copy.

See also [[ui_test_write_verification]] and [[native_select_arrow_key_writes]]
for the TagSelect regression this fixture-finding was for.
