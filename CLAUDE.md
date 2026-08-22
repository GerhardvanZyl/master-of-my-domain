# Property Compare — project guide

A local, single-user Next.js app that scrapes property listings (Domain &
realestate.com.au), stores them in SQLite + images on disk, and compares them
side by side. Photos are tagged by **you, Claude Code**, running interactively
in this repo.

## Stack / layout
- For day-to-day browsing use `npm run build && npm start` (same port, 3225):
  the home grid renders in ~90ms in production vs ~1.2s under `next dev`. Stop
  the dev server first — they share `.next`.
- `extension/` — a Chrome MV3 capture extension: while you browse a Domain/REA
  listing it POSTs the page's embedded data to `POST /api/ingest`, which saves
  it to the same DB. This is the primary ingest path; `npm run scrape` (Playwright
  CLI) still works for one-off URL scrapes.

## Photo tagging

**All DB writes go through the npm CLI helpers — never edit `data/app.db` or
image files directly, and never guess a room from a filename or URL: Read the
actual image.** The full procedure, room vocabulary and local-model first pass
live in the `tag-photos` skill.

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

## The live app runs on another host

`http://192.168.68.125:3225` is the instance that matters — **not** this
workstation. It runs `docker-compose.yml`, which bind-mounts
`${LIVE_DATA:-../property-compare-data}` — a directory **outside the repo** —
at `/app/data`. Deploy there is code only: `git pull` + rebuild. Nothing git
does can reach the live DB or images.

The repo's own `data/app.db` + `data/images` are still tracked, but they are a
snapshot for this dev box, **not** what prod reads, and they run behind it
(prod is fed by `/api/batch`). Never "deploy" by copying them over — that is
the data loss this mount exists to prevent. The container logs the DB it opened
and its row count on connect (`[db] /app/data/app.db — 442 properties`); check
it after any deploy that touched the mount.

Updates go over **`POST /api/batch`** — the whole
update write path over HTTP, so a run on this machine can update the live app
without shipping a 10MB SQLite file. Sections (all optional, all idempotent,
applied in this order):

| section | mirrors | notes |
| --- | --- | --- |
| `properties` | `npm run load` | `LoadItem[]`, upsert by `listing_url`, partial |
| `images` | `npm run load:images` | server downloads; SLOW — chunk it |
| `tags` | `npm run tag:set` | `notes` carries `hero`/`floorplan`/`master`; `ifAbsent` never clobbers a hand correction |
| `groups` | `group:ensure` + `group:add` | reused by label, membership deduped |
| `sold` / `withdrawn` | `npm run mark-sold` | replaces prior status + `Sold` row in place |
| `priceObserve` | `npm run price:observe` | |

Bad rows are collected into `errors` and reported with `ok: false` rather than
failing the request, so one dud can't discard the other 300 — **check `errors`,
a 200 is not proof of a clean apply.** `GET /api/batch` returns a coverage
summary for verification. Client: `node scripts/batch-push.mjs --base=<url>
--file=<payload.json>` (chunks the image section), or `--status`.

The shared logic lives in `src/db/queries/status.ts` so the CLIs and the
endpoint cannot drift. There is deliberately **no auth**: `/api/ingest` already
takes unauthenticated writes on this LAN, so a token here would lock one of two
doors. Add one when the app leaves the LAN.

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
