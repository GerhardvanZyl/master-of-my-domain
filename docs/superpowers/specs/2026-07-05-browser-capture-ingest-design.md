# Plan B — Browser-Capture Ingest

**Date:** 2026-07-05
**Status:** Approved, pending implementation plan

## Problem

Ingest today works by pasting listing URLs into a form → `POST /api/scrape` →
a queue → `runScrape` renders the page with server-side Playwright → an adapter
extracts embedded JSON → `upsertProperty` + `syncImages`. The **server-side
render is what hits Domain/REA anti-bot walls**. The user's own logged-in
browser does not.

## Goal

Replace the paste-and-scrape path with a Chrome extension that captures the
listing data **from the page the user is already viewing** and sends it to the
existing local app DB. Remove the paste-URL server-render path.

Decisions (from brainstorming):
- **Trigger:** auto-save on view. The server upsert is idempotent by
  `listingUrl`, so revisiting a listing just refreshes its row — no duplicates.
- **Removal scope:** minimal. Delete only the paste path; keep the
  `npm run scrape` Playwright CLI and the adapters/`runScrape`/`browser.ts`
  stack it uses.

## Architecture / data flow

```
You browse a Domain/REA listing (logged in, real browser)
        │
   [extension] extracts the same embedded JSON the adapters already read
        │  POST http://localhost:3000/api/ingest
        │  { url, nextData, jsonLd, globals, imgUrls, title, ogTitle }
        ▼
   /api/ingest → pickAdapter(url) → adapter.normalize(raw)
              → upsertProperty + syncImages → upsert scrape_jobs log row
        ▼
   Property + photos appear in the app exactly as before
```

The extension is a **dumb collector**. All normalization stays server-side. The
adapters are refactored so their logic runs from a raw payload instead of a
Playwright `Page`, and **both** the extension and the existing CLI feed the same
`normalize()`. No extraction logic is duplicated or reimplemented in the
extension.

## Server changes

### `RawPageData` type (`src/scrape/types.ts`)
```ts
interface RawPageData {
  url: string;
  nextData?: unknown;   // parsed #__NEXT_DATA__
  jsonLd?: unknown[];   // parsed <script type="application/ld+json"> blocks
  globals?: unknown;    // REA: window.__INITIAL_STATE__ / ArgonautExchange / REA
  imgUrls?: string[];   // rendered <img> srcs (DOM fallback)
  title?: string;       // document.title
  ogTitle?: string;     // <meta property="og:title">
}
```

### Adapter refactor (`src/scrape/adapters/*`, `base.ts`, `extract.ts`)
- Replace `Adapter.extract(page, url)` with a **pure** `normalize(raw: RawPageData): ExtractResult`.
  All existing `firstDeep` / `collectImageUrls` / price parsing logic moves in
  unchanged. `root = raw.nextData ?? raw.globals ?? {}`. Image DOM fallback
  filters `raw.imgUrls` by the site's host regex. Address og:title fallback uses
  `raw.ogTitle`.
- The Playwright-specific reads (`readNextData`, `readJsonLd`, REA window
  globals, `<img>` srcs, title/body) and the **anti-bot wall check** move into
  one shared helper `readRawFromPage(page, url): Promise<RawPageData>` in
  `extract.ts`. `normalize` contains no wall logic (the extension path has no
  wall — it's a real browser).
- `Adapter` interface becomes `{ site, matches, normalize }`.

### `runScrape` (CLI path, `src/scrape/runScrape.ts`)
`const raw = await readRawFromPage(page, url); const { property, images } = adapter.normalize(raw);`
— same observable behavior; `npm run scrape` keeps working.

### `POST /api/ingest` (`src/app/api/ingest/route.ts`, runtime nodejs)
1. Parse body as `RawPageData`. `pickAdapter(url)` by host → 400 if unsupported.
2. `adapter.normalize(payload)` → `{ property, images }`.
3. `upsertProperty(property)` → `propertyId`.
4. `syncImages(propertyId, images, url)` — server fetches image bytes from the
   CDN (`domainstatic.com.au` / `reastatic.net`), same as today.
5. Upsert a `scrape_jobs` row (`status: 'done'`, `propertyId`, `url`) — one row
   per listing URL, so Search History stays one-line-per-listing.
6. Return `{ ok, propertyId, images }`.

## The extension (`extension/`, Manifest V3, vanilla JS, no build step)

Reading REA's `window` globals requires a **MAIN-world** script (isolated
content scripts can't see page globals). A cross-origin POST to localhost is
done from the **background** service worker via `host_permissions` (avoids
CORS / mixed-content entirely). That is the platform minimum — four files:

- **`injected.js`** (`world: "MAIN"`, `run_at: document_idle`) — extracts
  `#__NEXT_DATA__` text, JSON-LD blocks, `window.__INITIAL_STATE__` /
  `ArgonautExchange` / `REA`, `document.images` srcs, `document.title`, og:title
  → `window.postMessage({ source: 'momd-collect', payload }, '*')`.
  Fires only on listing-detail URLs and only when the URL changed since the last
  send. Polls `location.href` (~1s) to re-fire on Domain's SPA navigation.
- **`content.js`** (isolated world) — receives the `postMessage`, forwards via
  `chrome.runtime.sendMessage`.
- **`background.js`** (service worker) — `onMessage` → `fetch` POST to
  `http://localhost:3000/api/ingest`.
- **`manifest.json`** — MV3; two content-script entries (MAIN `injected.js` +
  isolated `content.js`) matching `*://www.domain.com.au/*` and
  `*://www.realestate.com.au/*`; `host_permissions: ["http://localhost:3000/*"]`;
  `background.service_worker: "background.js"`.

### Listing-detail URL heuristic (in `injected.js`)
- Domain: path ends with a long numeric listing id (`/-\d{6,}$/`).
- REA: path starts with `/property-`.

Non-listing pages (search/suburb results) are skipped client-side; the server is
the final authority (unsupported host → 400).

## Removal (minimal)

Delete the paste path only:
- `src/components/AddLinksForm.tsx`
- `src/components/JobStatus.tsx`
- `src/app/api/scrape/route.ts`
- `src/app/api/jobs/route.ts`
- `src/scrape/queue.ts` (only caller was `/api/scrape`; the CLI uses `runScrape`
  directly)
- Their imports/usages in `src/app/page.tsx`.

Keep: `scrape_jobs` table (now the ingest log), `runScrape`, adapters,
`browser.ts`, `readRawFromPage`, and the `npm run scrape` CLI.

## Testing

- `test/adapters.test.ts` updated to the new `normalize(raw)` interface — feeds
  raw fixtures directly (no browser needed for the pure path; faster; tests the
  exact path the extension uses). Anti-bot wall-detection tests exercise
  `readRawFromPage` via `page.setContent`. `npm test` stays green.
- Extension: manual verification only (load unpacked → open a real Domain and a
  real REA listing → confirm the property row + photos appear at
  `localhost:3000`). No automated browser test — YAGNI for a single-user local
  extension.

## Deliberate simplifications (ponytail)

- **Images server-fetched from the CDN.** Add an "extension sends image bytes"
  path only if the CDN ever walls server-side fetches.
- **SPA re-fire is a 1s `location.href` poll.** Upgrade to a History API hook
  only if it feels laggy.
- **`scrape_jobs` reused as the ingest log** rather than a new table.
```
