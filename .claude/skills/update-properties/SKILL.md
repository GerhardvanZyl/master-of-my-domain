---
name: update-properties
description: Fetch the latest Point Cook / Williams Landing / Torquay / Seabrook listings from Domain, load them with full galleries INCLUDING floorplans, set exact Domain cover heroes, tag rooms with the local model, refresh transit and price history, and update the live app. Use when the user says "update the properties", "fetch the latest properties", "sync Domain", "get the new listings", or asks for any part of that round.
---

# Update properties (the full round)

The recurring job. Every step below is expected — a partial run is a failed run.
The user has asked for each of these explicitly and emphatically:

1. Fetch the latest listings and insert them.
2. **Get the floorplans.** They are the most-missed item.
3. **Get the correct hero images** (Domain's own cover, not a heuristic).
4. Tag the rooms with the local model.
5. Update travel info.
6. Update pricing history.
7. **Make sure the live app at `http://192.168.68.125:3225` ends up updated.**

## Before you start

- **The live app is on another machine.** This workstation is 192.168.68.105;
  `.125` is the instance that must be current when you finish. Nothing listens
  on `127.0.0.1:3225` unless you start it.
- **Browser automation is local-only, per connection.** Call `switch_browser`
  and let the user click Connect. Never pick a browser yourself. Then *prove*
  it is local: point it at the loopback-only receiver and confirm the file
  appears (see step 0). `isLocal` is not trustworthy.
- **Domain JS approval is per-call and cannot be made persistent.** Every
  `javascript_tool` call on domain.com.au pops a prompt the user must click, and
  an unattended one returns "Permission denied by user". So: design each call as
  ONE long unattended loop, and **tell the user before you fire it**.
- **Node and Playwright cannot read Domain** — plain `fetch` gets a 403 Akamai
  wall, `npm run scrape` hits the anti-bot wall. The extension driving the
  user's own Chrome is the only path. Don't burn time re-testing those.
- **Same-origin `fetch` of a Domain page is challenged too** (HTTP 200 with a
  ~2.5KB bot-challenge body). Read pages through a hidden **iframe** instead —
  a document request is not challenged.

## 0. Set up

```bash
node scripts/_receiver.mjs &          # writes POSTed harvest to data/harvest/
node scripts/_snapshot.mjs            # prices + marker; the diff needs this
```

Then `switch_browser`, navigate the tab to `http://127.0.0.1:3300/?name=_localcheck`,
and confirm `data/harvest/_localcheck.json` appeared. That file can only be
written by a browser on this machine, so it is the locality proof.

**Delete stale harvest files before each run** (`data/harvest/feed.json`,
`drop.json`). They persist between sessions and reading last week's feed as if
it were today's is a silent, expensive mistake.

## 1. Search feed (1 approval, ~90s)

Navigate to the standing search and run `scripts/browser/feed-harvest.js`:

```
https://www.domain.com.au/sale/?suburb=point-cook-vic-3030,williams-landing-vic-3027,torquay-vic-3228,seabrook-vic-3028&bedrooms=3-any&bathrooms=2-any&carspaces=2-any&price=600000-1100000&ssubs=0
```

Search pages are WAF-tolerant — page them rapidly (1.3s). The call ends by
navigating itself to `http://127.0.0.1:3300/#MOMD=<payload>`; then run
`scripts/browser/bridge-post.js` on the receiver page (127.0.0.1 never prompts)
with `name=feed`.

**`__NEXT_DATA__` streams.** A length check alone is not enough — the tag can be
in the DOM and past 5000 chars while its text is still arriving, giving
"Unterminated string in JSON". **Parsing IS the readiness test**: catch the
parse error and keep polling. Getting this wrong silently truncates the run
(it cost 6 of 16 pages once).

The feed gives, for free and with no listing fetch:
- **`images[0]` IS the og:image cover** → exact heroes, no WAF grind.
- `features.propertyTypeFormatted` → the house-and-land filter.
- price, tags, beds/baths/parking/land, lat/lng, next inspection.

## 2. Load + diff

```bash
node scripts/_feed-sync.mjs                       # -> feed-items.json + triage
npm run load -- data/harvest/feed-items.json
node scripts/_sync-diff.mjs                       # -> _diff.json
```

- **Price parsing must be `$`-anchored.** Domain's price is free text ("Call
  0452…", "684sqm", "UNDER CONTRACT - $820K"). An unanchored parser stores phone
  numbers and land sizes as prices.
- **Completed homes only — drop house-and-land** every run, not once.
  `propertyTypeFormatted` starting "New " or containing "off the plan" is the
  authoritative signal; address shapes (`^Lot`, `TURNKEY`, `^CORNER`,
  `"<Estate> Grove - <Street>"`) catch the ones relisted under a tidied address.
- **The suburb filter in the MISSING query is essential.** Without it the 25
  frozen NSW/Sydney rows are swept in as missing on every run. Those rows are
  frozen — never update them.

## 3. Per-listing pass (floorplans + sold prices)

```bash
node scripts/_pass-targets.mjs      # -> data/harvest/_pass-<n>.js, chunked
```

One paced loop covers every reason a listing page is needed: new listings' full
galleries, missing listings' sold/withdrawn status, in-feed listings whose price
says SOLD, and unusable price text.

- **45s spacing, 10-minute backoff.** Listing pages trip the WAF at ~12s
  spacing (~44 in a row) and then stay hot. Search pages are the tolerant ones.
- **Chunk to ~14 listings.** At ~25 photos × ~172 chars, 40 listings is ~180KB
  raw and ~400KB percent-encoded — past what a hash-bridge navigation carries.
  Each chunk bridges only its own results; localStorage is the resume log.
- **Tell the user to keep the tab in the foreground** — Chrome throttles timers
  in background tabs and stretches the spacing.
- **Union the page HTML and `galleryV2`, but trust them DIFFERENTLY.** Neither
  alone is complete and neither is clean:
  - `componentProps.galleryV2.photos[].desktopUrl` is **authoritative — take it
    all, whatever listingId the filenames carry.** A relisted property keeps the
    previous listing's photo ids (8 Lure Ave: 10 photos prefixed `2020487905_`,
    only its floorplan under its own id), so filtering these by `external_id`
    throws the entire gallery away and leaves the listing with one photo.
  - The page HTML catches the floorplans `galleryV2` omits on project pages, but
    also carries a "similar listings" carousel of **other properties' covers**
    and agency logo/banner images. Accept a basename there only if `galleryV2`
    already vouched for that listingId, or it is `<external_id>_`.
  Regex `https://rimh2.domainstatic.com.au/[^"'\s\\<>]+`, keep URLs with
  `fit-in/<w>x<h>`, keep the largest variant per basename, order by photoIndex.
  Domain puts the floorplan **last**.
  **Never exclude `)` from the character class** — the tail contains
  `no_upscale()` and excluding it truncates every URL at `filters:format(webp`.
- **Sanity-check the per-listing photo counts.** A new listing returning 1–2
  photos is a capture failure, not a thin listing; re-pass it.

```bash
node scripts/_pass-apply.mjs pass-1               # -> _gallery-*.json, _status-*.json
npm run load:images -- data/harvest/_gallery-pass-1.json
```

Dedupe on **basename**, not `source_url`: Domain re-signs every URL per capture,
so `syncImages` cannot tell a re-harvest from a new photo and will store the
gallery twice.

**Sold vs withdrawn:** Domain keeps sold/under-offer listings IN the feed under
`tags.tagText = "Under offer"`, so absence is not the only signal. Treat as
**sold** only when the price text matches `/\bsold\b/i`; plain "Under
contract"/"Under offer" is not settled — leave it live. A page redirecting to
`/property-profile/` with no listingModel is **withdrawn**. Apply with
`npm run mark-sold -- --url=<url> --price=<n|none> [--date=]`.

## 4. Tag rooms with the local model — BEFORE heroes

Needs LM Studio serving a vision model at `http://127.0.0.1:1234/v1` with
`LOCAL_VLM_MODEL` (qwen/qwen3-vl-8b) loaded, and ffmpeg on PATH. If it is not
running, **ask the user to start it** rather than silently hand-tagging.

```bash
npm run tag:auto -- --threshold=0.8
```

`--threshold` measures nothing — the model returns ≥0.95 on 98% of photos
*including its mistakes*, so every value 0.70–0.95 is byte-identical. Don't tune
it and don't run a benchmark to pick one. Agreement with hand tags is ~93%;
accept that and correct the rest in the app.

Then read the low-confidence queue yourself, and tag floorplans explicitly:

```bash
npx tsx scripts/tag-set.ts --image=<id> --room=other --notes=floorplan
```

`notes='floorplan'` beats `pickFloorplan`'s shape heuristic, which misses
floorplans rendered at 4:3, 1.29, 1.47 and even 3:2. Finally top up the six
comparison groups, one representative image per property per group.

**Call `npx tsx scripts/tag-set.ts` directly — `npm run tag:set -- --image=…`
drops the `=` arguments on this PowerShell.**

## 5. Heroes — Domain's exact cover, AFTER tagging

```bash
node scripts/_apply-heroes.mjs --dry-run     # then without the flag
```

**Order matters and it is not obvious.** Applying heroes first inserts an
`image_tags` row carrying only `notes='hero'`; `tag:auto` writes through
`setImageTagIfAbsent` (`ON CONFLICT DO NOTHING`), so it would skip that row and
leave the cover photo permanently untagged. Tag first, then set heroes.

Match the full basename, falling back to the `<listingId>_<photoIndex>_` prefix
(relisted properties' covers carry a different listingId than our external_id).
**Check `notes='hero'`, not `tagged_by`.** Expect non-3:2 heroes — that IS what
Domain leads with, and it is exactly why exact beats the old aspect heuristic.

## 6. Enrichment + transit

```bash
npx tsx scripts/compute-stations.ts && npm run load -- data/harvest/stations.json
npx tsx scripts/compute-metadata.ts && npm run load -- data/harvest/metadata.json
npx tsx scripts/_alt-new.ts                      # altitude, NSW excluded
```

`compute-altitude.ts` loads with no filter, so it cannot be used on the mixed
DB — scope to `WHERE altitude_m IS NULL AND state<>'NSW'`. `compute-stations` /
`compute-metadata` write files first, so strip NSW before loading.

Transit to Flinders St at 07:30 weekday, for new listings only — Google Maps URL
template with a dummy place-id and coords, `!3e3` for transit, epoch = next
Monday 07:30 as **UTC wall-clock** (this browser feeds Maps UTC and Maps reads it
as Melbourne local). `get_page_text` times out on Maps; read
`document.body.innerText` and take the headline duration. Fallback:
`npx tsx scripts/_transit-estimate.ts --apply` (nearest measured neighbour,
zone-split so Torquay never borrows a Point Cook time). `pt_steps` must not
start "Estimated" unless it really is — that prefix drives the UI's `*` marker.

Torquay's commute is **drive to Waurn Ponds + V/Line to Southern Cross**, not
the bus-to-Flinders routing Google returns by default.

## 7. Price history

```bash
npm run price:observe        # our own dated record, append-only, idempotent
```

Never add observations via `npm run load` with a `priceHistory` array as a way
of replacing history. For new listings, Domain's own timeline comes from
`/property-profile/<slug>` (Apollo `timeline`) — that sweep is WAF-heavy, so
pace it and accept partial coverage.

## 8. Update the live app — DO NOT SKIP

Preferred, no git round trip:

```bash
node scripts/batch-push.mjs --base=http://192.168.68.125:3225 --file=<payload.json>
node scripts/batch-push.mjs --base=http://192.168.68.125:3225 --status
```

`POST /api/batch` mirrors every CLI (properties / images / tags / groups / sold /
withdrawn / priceObserve). **Check the `errors` array — a 200 is not proof of a
clean apply**, bad rows are collected rather than thrown.

Otherwise commit `data/` and have the user `git pull` + rebuild on `.125`.

## Finish

```bash
node scripts/_verify.mjs    # checks every claim the report will make
npm run tag:status
```

`_verify.mjs` exists because the per-step output is easy to over-read: it
re-derives the counts from the DB, and asserts the things that quietly go wrong
— live listings with photos but no explicit hero, VIC rows with null transit or
station, and that the 25 frozen NSW rows still number 25 with their transit
intact.

Report: new listings, price changes, sold/withdrawn, photos + floorplans added,
heroes set, rooms tagged, transit filled, and **that the live app is updated**.
