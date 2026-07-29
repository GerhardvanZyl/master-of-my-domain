---
name: floorplan-metadata-batches
description: How to run floorplan room-size metadata jobs (npm run meta:set) — resolution/legibility checks and skip criteria
metadata:
  type: project
---

The floorplan metadata job (master-bed/avg-other-bed/common-areas via `npm run meta:set`)
draws floorplan images from many different real-estate agencies. A large fraction of
agency-produced plans (e.g. Ausfortune, VicProp/Minds&Media, some McGrath-style plans)
print room labels with **no dimension numbers at all** — not blurry, just absent. These
are legitimate skips ("no dimensions printed on floorplan"), not something to infer from
room proportions.

Separately, some floorplan images in `data/images/<id>/` are genuinely low-resolution
(seen one at 286x626 px for a 3-panel ground+first+site-plan composite, another at
267x400 — the latter was still just legible after close reading, the former was not).
Before deciding "illegible", check pixel dimensions with sharp:
`node -e "require('sharp')('path').metadata().then(m=>console.log(m.width,m.height))"`
— under ~300px on the long axis for a multi-panel composite is a reasonable illegible
threshold; single-panel plans around 580-700px wide with clear print were legible.

**How to apply**: when given a batch of {id, floorplans} to read, always Read the actual
image first — do not pre-judge by resolution alone. Only fall back to the pixel-dimension
check when the rendered text is ambiguous, to decide skip vs. squint-and-read.
