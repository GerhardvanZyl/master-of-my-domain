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
- **The local `data/app.db` is READ-ONLY. Every write goes to `.125` over
  `POST /api/batch`.** That is a standing user rule, and it has a consequence
  the steps below are built around: the local DB lags a full round, so it cannot
  serve as the baseline either. `_snapshot.mjs`, `_sync-diff.mjs`,
  `_pass-apply.mjs`, `_alt-new.ts` and `_verify.mjs` all open it — every one has
  a `-live` sibling that reads the same facts back over HTTP instead. **Use the
  `-live` ones.** Reach for a local-DB script and you will silently drop the
  listings this round just inserted, because they exist only on `.125`.
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
node scripts/_snapshot-live.mjs       # baseline pulled from .125; the diff needs this
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
https://www.domain.com.au/sale/?suburb=point-cook-vic-3030,williams-landing-vic-3027,torquay-vic-3228,seabrook-vic-3028&bedrooms=3-any&bathrooms=2-any&carspaces=1-any&price=600000-1100000&ssubs=0
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
node scripts/batch-push.mjs --base=http://192.168.68.125:3225 \
  --file=<{properties:[...feed-items]}>           # upsert by listing_url
node scripts/_snapshot-live.mjs                   # re-baseline AFTER the insert
node scripts/_sync-diff-live.mjs                  # -> _diff.json
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
- **MISSING is judged against the RAW feed, not the filtered items.** A
  house-and-land listing is still live on Domain — we just refuse to load it.
  Diffing against `feed-items.json` marks every one of them withdrawn.
- **React Flight doubles a leading `$`.** The live app's snapshot arrives with
  every price as `$$790,000`, because a leading `$` marks a reference in the
  Flight protocol. `_snapshot-live.mjs` unescapes it. Skip that and ~190 rows
  look like price changes on every single run — it reads exactly like data
  corruption and it is not.
- **Filter the snapshot to rows whose `listing_url` is a URL.** The config
  pseudo-row stores a timestamp there, so a truthiness check lets it through.

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
node scripts/_pass-apply-live.mjs pass-1          # -> _gallery-*.json, _status-*.json
node scripts/batch-push.mjs --base=http://192.168.68.125:3225 \
  --file=data/harvest/_gallery-pass-1.json        # images section — SLOW, chunk it
```

Dedupe on **basename**, not `source_url`: Domain re-signs every URL per capture,
so `syncImages` cannot tell a re-harvest from a new photo and will store the
gallery twice. The live snapshot gives `image_count` but not basenames, so the
only safe rule over HTTP is the one `_pass-apply-live.mjs` enforces: **load a
gallery only for a property at zero photos**, and report the rest rather than
guessing. It also drops what the app would never render anyway — squares,
banner strips, sub-500px icons, read off the `-w<W>-h<H>` basename. Those come
in via the page-HTML source and then sit permanently untagged, because the
property page never lists them for the tagger to reach.

**Sold vs withdrawn:** Domain keeps sold/under-offer listings IN the feed under
`tags.tagText = "Under offer"`, so absence is not the only signal. Treat as
**sold** only when the price text matches `/\bsold\b/i`; plain "Under
contract"/"Under offer" is not settled — leave it live. A page redirecting to
`/property-profile/` with no listingModel is **withdrawn**. Apply through the
batch payload's `sold` / `withdrawn` sections (same code path as
`npm run mark-sold`, which writes the local DB and must not be used here) —
`_pass-apply-live.mjs` writes both lists to `_status-pass-<n>.json` ready to push.

## 4. Tag rooms with the local model — BEFORE heroes

Needs LM Studio serving a vision model at `http://127.0.0.1:1234/v1` with
`LOCAL_VLM_MODEL` (qwen/qwen3-vl-8b) loaded, and ffmpeg on PATH. If it is not
running, **ask the user to start it** rather than silently hand-tagging.

```bash
npx tsx scripts/_tag-remote.ts data/harvest/_tags-1.json    # then push the file
```

`tag:auto` reads `data/app.db` and `data/images`, neither of which holds this
round's photos. `_tag-remote.ts` does the same job over HTTP: it discovers image
ids from the live property pages (document order = ordinal order), pulls the
bytes from `/api/img`, classifies with the same local model, and emits a
`/api/batch` tags payload. It **also sets the hero in the same pass** — see
step 5 for why that is the correct order rather than a shortcut.

**The confidence number measures nothing.** The model returns ≥0.95 on 98% of
photos *including its mistakes*, so any threshold between 0.70 and 0.95 gives a
byte-identical result. Don't tune one and don't benchmark to pick one. Agreement
with hand tags is ~93%; accept that and correct the rest in the app.

Non-hero tags go out with `ifAbsent: true` — with one exception: the floorplan
mark (below) may overwrite an already-tagged image, but only when its existing
tag is machine-written (no tag row, or `local-vlm`/`migration`/`rule`); a
hand-curated tag (`claude-code`, `domain-cover`, `user`, ...) is never
clobbered. A re-run now **skips** any image that already carries a room type
(other than the last-position/hero exemption above), so it no longer
reclassifies everything — expect `written`/`skipped` to reflect how many
images were actually new or eligible for re-examination, not the whole photo
count.

`notes='floorplan'` beats `pickFloorplan`'s shape heuristic, which misses
floorplans rendered at 4:3, 1.29, 1.47 and even 3:2. `_tag-remote.ts` applies it
automatically to a last-position photo the model called "other" — including an
already-tagged one, since that's the only slot the mark can ever land on; it
preserves that image's existing room type rather than overwriting it with the
fresh (coarser) verdict. For floorplans on images `_tag-remote.ts` never
revisits, `scripts/_recover-floorplans.ts` is the dedicated recovery pass.

Then top up the six comparison groups — one representative image per property
per group, because the app renders one column per property:

```bash
node scripts/_groups-from-tags.mjs data/harvest/_groups.json data/harvest/_tags-*.json
```

`_group-topup.ts` queries the local DB. This builds the same thing from the tag
payloads the round just produced: `_tag-remote.ts` records `propertyId` and
`ordinal` next to each tag (both stripped before the push), so the lowest-ordinal
photo of each room type is pickable with no second pass over the live pages.

**Call scripts via `npx tsx`/`node` directly. `npm run <script> -- --key=value`
drops the `=` arguments on this PowerShell.**

## 5. Heroes — Domain's exact cover, AFTER tagging

Nothing to run — `_tag-remote.ts` set them in step 4. This section is the *why*,
because the ordering constraint is the part that bites.

**Order matters and it is not obvious.** Applying heroes first inserts an
`image_tags` row carrying only `notes='hero'`; `tag:auto` writes through
`setImageTagIfAbsent` (`ON CONFLICT DO NOTHING`), so it would skip that row and
leave the cover photo permanently untagged. Tag first, then set heroes — which
is why `_tag-remote.ts` classifies the cover photo like any other and merely
overwrites its `notes` with `hero` (`ifAbsent: false` for that one row — see
step 4 for the full `ifAbsent` rule, including the floorplan mark's own
conditional overwrite).

Match the full basename, falling back to the `<listingId>_<photoIndex>_` prefix
(relisted properties' covers carry a different listingId than our external_id).
**Check `notes='hero'`, not `tagged_by`.** Expect non-3:2 heroes — that IS what
Domain leads with, and it is exactly why exact beats the old aspect heuristic.

## 6. Enrichment + transit

```bash
PROPS_JSON=<this round's rows> npx tsx scripts/compute-stations.ts
PROPS_JSON=<this round's rows> npx tsx scripts/compute-metadata.ts
node scripts/_alt-new-live.mjs                   # altitude, NSW excluded
# then push stations.json / metadata.json / the altitude payload to .125
```

`compute-altitude.ts` loads with no filter, so it cannot be used on the mixed
DB — scope to `WHERE altitude_m IS NULL AND state<>'NSW'`. `compute-stations` /
`compute-metadata` write files first, so strip NSW before pushing. Both accept
`PROPS_JSON`, so feed them this round's rows rather than the stale local DB.

Transit to Flinders St at 07:30 Monday, for new listings only:

```bash
node scripts/_transit-measure.mjs urls  data/harvest/_measure-metro.json
node scripts/_transit-measure.mjs apply data/harvest/_measure-metro.json \
  data/harvest/_measured.json data/harvest/_batch-transit.json
```

The URL contract is in that file's header and is worth reading before touching
it — the `data=` blob is a protobuf-ish token stream whose length prefixes Maps
validates, so it cannot be hand-trimmed. Two traps in particular:

- **`!1s` is NOT a dummy place-id.** The destination comes from that feature id,
  not from the readable path segment. Leaving a Sydney id in place while writing
  Flinders into the path returns a Melbourne → Museum Station, *Sydney* trip.
- **Read the FIRST trip, not the shortest.** Google decorates trip rows with
  Private Use Area glyphs (U+E88E sits between the duration and the time), which
  are not `\s` — a whitespace-anchored regex skips the earliest departures and
  silently matches a later, shorter one. Strip `[\uE000-\uF8FF]` first.

`get_page_text` times out on Maps; read `document.body.innerText`, and note that
an async IIFE returns `{}` in this harness — wait, then evaluate synchronously.

Fallback: `npx tsx scripts/_transit-estimate.ts --apply` (nearest measured
neighbour, zone-split so Torquay never borrows a Point Cook time). It is
accurate to ~3 min on average, but the outliers are ±14 — measure when you can.
`pt_steps` must not start "Estimated" unless it really is; that prefix drives
the UI's `*` marker.

Torquay's commute is **drive to Waurn Ponds + V/Line to Southern Cross**, not
the bus-to-Flinders routing Google returns by default: measure the drive with
`!3e0`, then feed it to `scripts/_torquay-commute-build.mjs`. That builder
hardcodes its output path — **back up `data/harvest/torquay-commute.json`
first**, it will clobber the previous round's record. Its V/Line timetable is
also hardcoded (scraped Mon 10 Aug 2026); re-scrape if V/Line has changed.

## 7. Price history

The batch payload's `priceObserve` section — our own dated record, append-only,
idempotent. (`npm run price:observe` is the same code path, but it writes the
local DB.)

Never add observations via a `priceHistory` array on the `properties` section as
a way of replacing history. For new listings, Domain's own timeline comes from
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
node scripts/_verify-live.mjs    # checks every claim the report will make
```

`_verify-live.mjs` exists because the per-step output is easy to over-read: it
re-derives every count from `.125` over HTTP — never from the local DB, which
would happily report a clean run while the live instance sat untouched — and
asserts the things that quietly go wrong
— live listings with photos but no explicit hero, VIC rows with null transit or
station, and that the 25 frozen NSW rows still number 25 with their transit
intact.

Report: new listings, price changes, sold/withdrawn, photos + floorplans added,
heroes set, rooms tagged, transit filled, and **that the live app is updated**.
