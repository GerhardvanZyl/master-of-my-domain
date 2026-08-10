# Property Compare — project guide

A local, single-user Next.js app that scrapes property listings (Domain &
realestate.com.au), stores them in SQLite + images on disk, and compares them
side by side. Photos are tagged by **you, Claude Code**, running interactively
in this repo.

## Stack / layout
- Next.js App Router + TypeScript + Tailwind. SQLite via better-sqlite3 (Drizzle
  for typed queries). Playwright (playwright-core) for scraping.
- `src/db` schema + queries · `src/scrape` adapters/pipeline · `src/app` UI + API
  · `scripts/` CLI helpers · `data/` runtime DB + images (tracked in git, apart
  from the specific entries `.gitignore` lists: the SQLite WAL sidecars and
  `data/_tagbench.jsonl`).
- Run: `npm run dev`. Migrate: `npm run db:migrate`. Scrape from CLI:
  `npm run scrape -- <url>`.
- For day-to-day browsing use `npm run build && npm start` (same port, 3225):
  the home grid renders in ~90ms in production vs ~1.2s under `next dev`. Stop
  the dev server first — they share `.next`.
- `extension/` — a Chrome MV3 capture extension: while you browse a Domain/REA
  listing it POSTs the page's embedded data to `POST /api/ingest`, which saves
  it to the same DB. This is the primary ingest path; `npm run scrape` (Playwright
  CLI) still works for one-off URL scrapes.

## Photo-tagging job (this is your main interactive task)

When the user asks you to "tag the photos", classify each listing photo by room
type and cluster comparable rooms across properties. **All DB writes go through
the npm CLI helpers below — never edit `data/app.db` or image files directly, and
never guess a room from a filename or URL: Read the actual image.**

### Room vocabulary (exact strings)
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

The full disambiguation rules live in `ROOM_PROMPT` (`src/lib/room-classify.ts`)
and are shared verbatim by the model and the benchmark. Read that constant
before tagging by hand, so your labels and the model's agree.

### Commands (the only sanctioned write path — all idempotent)
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

### Correcting tags in the app
Click any photo to open the lightbox; the room dropdown writes immediately
(`tagged_by='user'`). Available on the property page's photo grid and hero
gallery, `/rooms`, and both `/compare` views. Photos tagged by machine
(`local-vlm`, `migration`) carry a marker next to the room badge, so a tag you
made by hand is visually distinct from one to double-check.

### The loop
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
   `npm run tag:set --image=<id> --room=<type>`.
3. Build cross-property comparison sets. For each room type that appears in **two
   or more different properties**, `group:ensure --label="<room>"`, then
   `group:add` **one best representative image per property** into that group.
   - Rule: **at most one image per property per group**, so the app's side-by-side
     view has one clean column per property. If a listing has several kitchens,
     pick the most representative. You may create finer labels (e.g.
     `"kitchen — renovated"`) when a simple room split isn't a fair comparison.
4. `npm run tag:status` to confirm `untagged: 0` and report the groups you made.

Re-running the whole job is safe: tags overwrite in place, groups are reused by
label, and group membership ignores duplicates.

### Where results show up
- Per-image room badges: property detail page and the home grid.
- `/rooms`: browse all photos of a room type across properties, or open a
  similarity group to see the curated side-by-side comparison.

## Offline capture

Notes and photos can be taken at an inspection with no connection and sync when
you're back on the network.

- `public/sw.js` — network-first for page navigations (cached copy when the
  server is unreachable), cache-first for `/_next/static`, `/api/img`,
  `/api/media` and `/icons`. API reads are never cached: stale property data is
  worse than none. Bump `CACHE` to invalidate everything.
- `src/lib/outbox.ts` — IndexedDB queue (`pc-outbox`/`queue`). `queue()` parks a
  job, `flush()` replays oldest-first and stops at the first job that needs a
  retry. Notes are last-write-wins per property; a 4xx drops the job so it can't
  jam the queue, a 5xx or network error keeps it.
- `src/components/SyncStatus.tsx` — header pill (count + manual retry) and the
  thing that actually drives `flush()`, on mount and on the `online` event.
  Rendered on every page, so anything queued syncs as soon as you open the app.
- `NotesEditor` and `MediaUploader` fall back to the outbox when their fetch
  throws; pending photos render with an amber "pending" badge until they upload.
- **Only pages visited while online are available offline.** There's no route
  precache — property pages are server-rendered per request.

## Conventions
- Keep the DDL in `src/db/ddl.ts` in sync with `src/db/schema.ts`.
- `price_history` rows with `event = 'Sold'`: `date` is the real sale date when
  known, the detection date otherwise (no way to tell them apart from the row
  alone). `npm run mark-sold` is the sanctioned way to record a sale — pass
  `--date` when you know the real one instead of hand-writing another
  `_apply-status*.ts`.
- Scrapers must degrade gracefully (store `raw_json`, set `scrape_status`) rather
  than throw — one site changing its markup shouldn't break a scrape.
- Tests: `npm test` (units/adapters/scoring/pipeline/ingest — no network needed).
  `npm run test:ui` drives the real UI in Chrome via playwright-core; it boots
  its own `next dev` against a throwaway copy of `data/app.db`, so it never
  writes to your real database, images or uploads.
