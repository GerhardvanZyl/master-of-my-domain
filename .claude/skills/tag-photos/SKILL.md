---
name: tag-photos
description: Tag property listing photos by room type and cluster comparable rooms across properties, so the app can show them side by side. Use when the user asks to "tag the photos", "tag rooms", "classify the photos", or "group similar rooms" in this property-compare repo.
---

# Tag property photos

You classify each listing photo by room type and build cross-property comparison
groups. You are the vision model for anything the local model isn't confident
about — **Read each image file** and decide from what you actually see.

**All DB writes go through the npm CLI helpers below — never edit `data/app.db`
or image files directly, and never guess a room from a filename or URL: Read the
actual image.** Every command here is idempotent, so re-running the whole job is
safe.

## Room vocabulary (exact strings)
`kitchen` · `bathroom` · `bedroom` · `living` · `dining` · `exterior` · `other`
· `aerial` · `exclude`

- `aerial` — annotated aerial/drone locality shots: callouts naming schools and
  shopping centres, the subject property outlined, agency logo. Not `exterior`.
- `exclude` — a display-control value, not a room: the image is hidden
  everywhere in the app. Agency branding, logo cards, pure text/price panels.
  Excluded images are reachable only at `/rooms?room=exclude`, which exists so
  the decision stays reversible — everywhere else they are invisible.
- `other` remains floorplans, site plans, circulation spaces (hallways,
  landings, staircases) and unidentifiable detail shots.
- Ambiguous/mixed shots (e.g. open-plan kitchen+living): pick the dominant room
  for the tag; the image can still join multiple similarity groups.

The full disambiguation rules live in `ROOM_PROMPT` (`src/lib/room-classify.ts`)
and are shared verbatim by the model and the benchmark. Read that constant
before tagging by hand, so your labels and the model's agree.

## Commands (the only sanctioned write path — all idempotent)
- `npm run tag:list` → JSON array of **untagged** images. Each item has
  `imageId`, `propertyId`, `address`, `ordinal`, and `absPath` (absolute file
  path — use your Read tool on it to view the photo). Filter with
  `-- --property=<id>` or `-- --limit=N`.
- `npm run tag:set -- --image=<imageId> --room=<type> [--confidence=0.0-1.0] [--notes="..."]`
  → sets/overwrites the room tag for one image.
- `npm run group:ensure -- --label="kitchen" [--room=kitchen]` → prints
  `{ "groupId": "..." }`. Reuses an existing group with the same label
  (case-insensitive), so call it freely.
- `npm run group:add -- --group=<groupId> --image=<imageId>` → adds an image to
  a similarity group (ignores duplicates).
- `npm run tag:status` → coverage summary (tagged/untagged counts, rooms, groups).
- `npm run tag:auto -- --threshold=<0..1> [--property=<id>] [--limit=N] [--model=<name>] [--dry-run]`
  → local vision model (LM Studio) tags what it is confident about, prints the
  rest as a review queue in the same JSON shape as `tag:list`. Only ever
  touches **untagged** images, writes `tagged_by='local-vlm'` and
  `notes='local:<model>'`, and reports written/skipped/queued/errored counts.
  `--threshold` is mandatory and has no default — a malformed value
  (`--threshold=` or non-numeric) exits non-zero rather than guessing. Exits
  non-zero if the model server is unreachable, having printed the partial
  queue; a single bad photo is skipped, not fatal.
- `npm run tag:bench [-- --properties=<id,id,...> --count=10 --limit=N --model=<name>]`
  → benchmarks a local model against your existing tags; writes nothing to
  the DB. Defaults to the 10 photo-richest properties (445 photos, ~20-60min
  full run). `--properties` is a comma-separated list, not a repeatable flag.

Both need LM Studio serving a vision model at `http://127.0.0.1:1234/v1`
(override with `LOCAL_LLM_URL` — include the `/v1` suffix, since `/chat/completions`
is appended to whatever this resolves to); the model id comes from
`LOCAL_VLM_MODEL` in `.env.local`, or `--model`.

**ffmpeg must be on PATH.** LM Studio's vision pipeline rejects webp, and 92% of
this library is webp, so every image is converted to JPEG (long edge 1024,
`--max-edge` to change) before it is sent. A missing ffmpeg aborts the run with a
message naming it; one unreadable file is skipped, not fatal. SVG files are
never sent at all — they are agency branding and are tagged `exclude` by rule,
marked `source: "rule"` so they are never mistaken for a model answer.

**`--threshold` measures nothing useful — do not tune it.** Measured over 118
photos, the model returns confidence ≥0.95 on 98% of images *including its
mistakes*, so every threshold from 0.70 to 0.95 produces byte-identical output.
It is retained as a guard against a typo'd invocation, not as a quality dial.
Agreement with hand tags is ~93%; the plan is to accept that and correct the
remainder in the app, not to gate harder.

## The loop

0. **Local first pass.** The threshold is recorded in
   `docs/superpowers/specs/2026-07-30-local-model-offload-design.md` once a
   benchmark has picked one — if it is not recorded there yet, run
   `npm run tag:bench` first to choose one; do not guess a number. Then run
   `npm run tag:auto -- --threshold=<T>` (needs LM Studio's server running).
   Confident photos are tagged by the local model and marked
   `tagged_by = 'local-vlm'`. It prints the low-confidence photos as JSON in
   the same shape as `tag:list` — those are the ones you Read yourself,
   continuing at step 1 below. If the server is not running the command exits
   non-zero and writes nothing; fall back to step 1 and tag everything by hand.
1. `npm run tag:list`. If empty, everything is tagged — stop.
2. For each image: **Read `absPath`**, decide the room type, then
   `npm run tag:set -- --image=<id> --room=<type>`. Tag in batches by property
   so you keep context. Re-tagging overwrites, so a correction is just another
   `tag:set`.
3. Build cross-property comparison sets. For each room type that appears in **two
   or more different properties**, `group:ensure --label="<room>"`, then
   `group:add` **one best representative image per property** into that group.
   - Rule: **at most one image per property per group**, so the app's side-by-side
     view has one clean column per property. If a listing has several kitchens,
     pick the most representative. You may create finer labels (e.g.
     `"kitchen — renovated"`) when a simple room split isn't a fair comparison.
4. `npm run tag:status` to confirm `untagged: 0`. Report how many photos you
   tagged, the room breakdown, and which groups you made. Point the user at
   `/rooms` in the app to view the results.

## Correcting tags in the app
Click any photo to open the lightbox; the room dropdown writes immediately
(`tagged_by='user'`). Available on the property page's photo grid and hero
gallery, `/rooms`, and both `/compare` views. Photos tagged by machine
(`local-vlm`, `migration`) carry a marker next to the room badge, so a tag you
made by hand is visually distinct from one to double-check.

## Where results show up
- Per-image room badges: property detail page and the home grid.
- `/rooms`: browse all photos of a room type across properties, or open a
  similarity group to see the curated side-by-side comparison.
