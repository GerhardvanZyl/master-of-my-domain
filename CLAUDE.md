# Property Compare — project guide

A local, single-user Next.js app that scrapes property listings (Domain &
realestate.com.au), stores them in SQLite + images on disk, and compares them
side by side. Photos are tagged by **you, Claude Code**, running interactively
in this repo.

## Stack / layout
- Next.js App Router + TypeScript + Tailwind. SQLite via better-sqlite3 (Drizzle
  for typed queries). Playwright (playwright-core) for scraping.
- `src/db` schema + queries · `src/scrape` adapters/pipeline · `src/app` UI + API
  · `scripts/` CLI helpers · `data/` runtime DB + images (gitignored).
- Run: `npm run dev`. Migrate: `npm run db:migrate`. Scrape from CLI:
  `npm run scrape -- <url>`.
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

### The loop
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

## Conventions
- Keep the DDL in `src/db/ddl.ts` in sync with `src/db/schema.ts`.
- Scrapers must degrade gracefully (store `raw_json`, set `scrape_status`) rather
  than throw — one site changing its markup shouldn't break a scrape.
- Tests: `npm test` (units/adapters/scoring/pipeline/ingest — no network needed).
  `npm run test:ui` drives the real UI in Chrome via playwright-core; it boots
  its own `next dev` against a throwaway copy of `data/app.db`, so it never
  writes to your real database, images or uploads.
