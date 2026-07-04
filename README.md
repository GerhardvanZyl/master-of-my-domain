# Property Compare

A local, single-user web app for comparing property listings. Paste listing
links (Domain / realestate.com.au); the app scrapes each one, stores the data
and photos in its own SQLite database, and lets you compare properties — and
their photos — side by side. Photos are tagged by room and grouped for
side-by-side comparison using **Claude Code**, interactively.

## Features

- **Paste & scrape** — drop one or many listing URLs; a background job renders
  each page (Playwright), extracts the embedded listing JSON, downloads all
  photos, and saves everything locally.
- **Side-by-side compare** — pick 2–4 properties; see price, beds/baths/parking,
  land size, type, agent aligned in a table with the best value highlighted, plus
  photo strips.
- **Room comparison** — after tagging, browse every "kitchen" (or any room) across
  all properties, or open a curated similarity group to compare one room
  property-by-property.
- **Interactive photo tagging** — run `claude` in this repo and use the
  `tag-photos` skill; Claude looks at each photo and tags its room + clusters
  comparable rooms across properties. See [CLAUDE.md](./CLAUDE.md).

## Requirements

- Node.js 20+ (developed on 22).
- A Chromium/Chrome browser for scraping. The app auto-detects common install
  locations; otherwise set `CHROMIUM_PATH` in `.env.local`, or run
  `npx playwright install chromium`.

## Setup

```bash
npm install
npm run db:migrate      # create data/app.db
npm run dev             # http://localhost:3000
```

Runtime data (the SQLite DB and downloaded images) lives in `data/` and is
gitignored.

## Usage

1. Open the app, paste listing links, click **Scrape**. Watch the job status;
   properties appear in the grid.
2. Tick **compare** on 2–4 properties → **Compare** to see them side by side.
3. Tag photos: in a terminal, `claude` → run the **tag-photos** skill (or say
   "tag the photos"). Then open **Rooms** to compare kitchens/bathrooms/etc.

### CLI

```bash
npm run scrape -- <listing-url> [<url> ...]   # scrape without the UI
npm run tag:list                               # untagged images (JSON)
npm run tag:set -- --image=<id> --room=kitchen
npm run group:ensure -- --label="kitchen"
npm run group:add -- --group=<id> --image=<id>
npm run tag:status
npm test                                       # offline adapter + pipeline tests
```

## How it works

- **Scraping** (`src/scrape`) — a pluggable adapter per site (`domain.ts`,
  `rea.ts`) reads the page's embedded `__NEXT_DATA__` / JSON-LD, normalizes it,
  and downloads images (content-hash de-duplicated). Re-scraping a listing
  updates it in place and **keeps existing images and their tags** — your tagging
  work is never lost. Anti-bot/consent pages are detected and recorded as errors
  rather than saved as junk.
- **Storage** (`src/db`) — better-sqlite3 with WAL, so the dev server and the
  tagging CLIs can share the DB. Schema in `src/db/schema.ts` / `src/db/ddl.ts`.
- **Tagging** (`scripts/*`, `CLAUDE.md`, `.claude/skills/tag-photos`) — small
  idempotent CLIs are the only write path for tags; Claude Code drives them.

## Notes & limitations

- **Personal use.** Domain and realestate.com.au prohibit scraping in their
  terms of service. This tool is for building a private, local comparison set at
  low volume — keep it polite and don't redistribute scraped content.
- Sites change their markup and may block automated access; scrapes degrade to a
  recorded error rather than crashing. Domain is the more reliable source.
