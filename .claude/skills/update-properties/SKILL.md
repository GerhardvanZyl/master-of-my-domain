---
name: update-properties
description: Fetch the latest Point Cook / Williams Landing / Torquay / Seabrook listings from BOTH Domain and realestate.com.au, load them with full galleries INCLUDING floorplans, set exact Domain cover heroes, tag rooms with the local model, refresh transit and price history, and update the live app. Use when the user says "update the properties", "fetch the latest properties", "sync Domain", "get the new listings", or asks for any part of that round.
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
8. **Do all of that for BOTH sources** — Domain (steps 0–8) *and*
   realestate.com.au (step 9). Only one source if the user names one.

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
- **domain.com.au JS permission is per BROWSER PROFILE, and a profile that
  lacks it denies SILENTLY.** Measured 2026-09-20 and this is the important
  one: on one Chrome profile, `navigate` to Domain succeeded and then *every*
  `javascript_tool` call on that tab returned `Permission denied by user`
  instantly — including a one-line `window.__D` read, with the user watching
  and no popup ever appearing. The user opened a DIFFERENT Chrome profile,
  `switch_browser` selected it, and the identical 6.5KB call ran first time.
  So:
  - **`Permission denied by user` on Domain is usually not a refusal**, and it
    is not the payload size. Diagnose it, do not retry: navigate the same tab
    to `http://127.0.0.1:3300/` and run `location.host`. If that works and
    Domain does not, the profile lacks Domain site access. **Retrying the big
    call proves nothing and wastes the user's time.**
  - **The fix is a different browser profile, not a different script.** Ask the
    user to open the Chrome profile that has Domain enabled, then
    `switch_browser` and let them Connect. Re-prove locality for the new
    connection — the local-only rule is per connection, and a fresh
    `?name=<probe>` through the receiver is free.
  - Everything staged in node survives a profile switch: the snapshot,
    `_round-call.js` and the receiver are all unaffected. Only re-do the
    locality proof and the navigate.
- **YOU GET ONE CONFIRMATION PER SYNC, AND IT MUST FETCH EVERYTHING.**
  That is the user's standing rule, not a guideline. That single call has to
  come home with **all of it — properties, full galleries, floorplans, prices,
  sold/withdrawn status, inspection dates**. A round that gets the feed on the
  one click and then needs a second one "just for the listing pass" has failed;
  so has one that returns listings without their floorplans. Structure the call
  as feed → diff → per-listing pass in a single unattended loop, and if the diff
  needs the live app's state, compute it in node BEFORE asking, then inline the
  target list.
  Do not spend the click on a probe, a locality check, or a first chunk of
  something. Ask for it EARLY, not after a long stretch of preparation, and say
  plainly that it is the one.
- **Small `javascript_tool` calls do NOT prompt at all; large ones are
  auto-denied with no prompt shown.** Measured 2026-09-07: ~1–2KB runs silently,
  a 15KB paste came back "Permission denied by user" with the user seeing
  nothing. So a 15KB script is not "one approval", it is a guaranteed failure.
  Keep the ONE call as small as it can be while still complete — strip the
  comment header, minify, and inline only the target list you actually need.
- **Do not assemble a script from string chunks and `eval` it, and do not
  base64 the body.** Both read as obfuscation and the auto-mode classifier
  blocks them (correctly). Same for a receiver route that redirects to an
  external URL — that reads as an open redirect. Send plain readable JS.
- Every `javascript_tool` call on domain.com.au is judged on its own; approval
  never persists. Design the call as ONE long unattended loop.
- **Node and Playwright cannot read Domain** — plain `fetch` gets a 403 Akamai
  wall, `npm run scrape` hits the anti-bot wall. The extension driving the
  user's own Chrome is the only path. Don't burn time re-testing those.
- **Same-origin `fetch` of a Domain page is challenged too** (HTTP 200 with a
  ~2.5KB bot-challenge body). Read pages through a hidden **iframe** instead —
  a document request is not challenged.

- **A round is BOTH sources, every time.** Stated 2026-09-06 after an REA-only
  round was reported as complete: the two do not overlap, each carries listings
  and price moves the other does not, and each has data the other lacks. Run
  them SEQUENTIALLY, not interleaved — Domain needs the permission popup, and
  REA's local-model tagging saturates the GPU. Whichever runs second
  re-baselines with `_snapshot-live.mjs` first, so it already sees the first
  half's inserts and cannot duplicate them. Report per source.
- **An REA `listing_url` must NEVER overwrite a domain.com.au one.** Both
  existing side by side is fine; the Domain link is the one the user clicks
  through to. This already holds — `loadProperties` leaves `listingUrl` out of
  its update `set`, so a capture merging onto an existing row keeps that row's
  URL — so the job is not to break it. In particular, a price or status update
  for a row we already hold must push the **held** row's `listing_url`, never
  the URL of whichever site the observation came from: `properties` upserts by
  `listing_url`, so pushing an REA link at a Domain row WOULD repoint it.
  `_rea-diff.ts` carries `listing_url` from the snapshot for exactly that
  reason — keep it. Never "fix" a link by delete + re-insert: the row carries
  ratings, notes, viewed state and price history.

## 0. Set up

```bash
node scripts/_receiver.mjs &          # writes POSTed harvest to data/harvest/
node scripts/_snapshot-live.mjs       # baseline pulled from .125; the diff needs this
```

Then `switch_browser` and let the user click Connect (if exactly one browser is
already connected, `list_connected_browsers` is enough — but still prove
locality). Navigate the tab to `http://127.0.0.1:3300/?name=_localcheck` and
confirm `data/harvest/_localcheck.json` appeared. That file can only be written
by a browser on this machine, so it is the locality proof. Loopback and
navigations are free — neither raises the Domain popup.

**Delete stale harvest files before each run** (`data/harvest/feed.json`,
`drop.json`, `pass-*.json`, `domain-round-gz.json`, `domain-retry-gz.json`).
They persist between sessions and reading last week's feed as if it were
today's is a silent, expensive mistake.

**Order the round so the popup happens once.** Only one column below costs
anything, so do all the free work FIRST and have the finished call in hand
before you touch Domain:

| free (no popup) | costs the popup |
| --- | --- |
| `switch_browser`, `list_connected_browsers`, `tabs_context_mcp` | any `javascript_tool` call on a domain.com.au tab |
| `navigate` — to loopback AND to Domain | ...including a one-line read |
| any `javascript_tool` on `127.0.0.1:3300` | |
| every node/tsx script in this skill | |

So: receiver → snapshot → **build the call** (step 1) → connect → locality proof
→ navigate to the Domain search → **ask for the permission, then paste the one
call**. Say plainly that it is the one. Never spend it on a probe, a locality
check, or a first chunk.

## 1. Build the ONE call — feed + diff + sold search + listing pass

**Build it in node BEFORE you ask for anything.** This is the only browser
action of the round that raises the popup, so it has to be the whole round:

```bash
node scripts/_snapshot-live.mjs     # baseline from .125 (step 0 already ran it)
node scripts/_round-ids.mjs         # -> data/harvest/_round-call.js
```

`_round-ids.mjs` minifies `scripts/browser/domain-full-round.js` and prepends
`window.__IDS` — what the live app already holds, as sorted Domain listing ids,
delta-encoded base36 (~1.6KB for 450). It self-checks the decoder against the
encoder, so a corrupt id list fails in node rather than in the browser. Paste
the file's contents **verbatim** as the `javascript_tool` text. Proven
2026-09-13: 6.2KB, 18 feed pages, 346 listings, feed → diff → sold search →
66 listing pages, bridged home in ~2.5h on one click.

**Why the held ids travel inside the call:** Domain's own page load DROPS the
URL fragment, so a `/goto`-style handoff arrives empty, and a cross-origin fetch
to 127.0.0.1 is blocked by Private Network Access. There is no third channel.
Id-matching reads a relist as "new" (25 of 45 one run); the server merges it by
address and it keeps its photos — extra fetches, not a bug.

The call keeps the payload in `localStorage` *before* navigating home, so if the
bridge navigation fails you re-send it from the receiver page instead of
re-running 2.5 hours of round. Then split what came back:

```bash
node scripts/_domain-round-split.mjs   # domain-round-gz.json -> feed.json, pass-1.json, _sold-search.json
```

It needs a fresh `data/harvest/_snapshot.json`: the browser only knows listing
ids, so a missing target comes home as `/<id>` and is mapped back to its held
`listing_url` here.

**A retry is another popup, so batch every failure into one.**
`node scripts/_round-ids.mjs --retry=<targets.json>` (`[{url, why}]`) builds
`_retry-call.js` — listing pass only, no feed or sold search — which bridges
home as `domain-retry-gz`. Budget ~2x the nominal spacing: a 41-page retry took
~75 min, not the ~31 the 45s implies.

Fallback only if the one-call build is broken: `scripts/browser/feed-harvest.js`
then `scripts/browser/listing-pass.js`, bridged with
`scripts/browser/bridge-post.js` on the receiver page (127.0.0.1 never prompts).
That is two popups, which is a failed round by the user's rule — fix
`domain-full-round.js` instead.

Two field bugs already paid for, both of which silently zero the round:

- **`galleryV2.photos[].desktopUrl` is an object `{"1x","2x"}`**, not a string.
  Treating it as a string threw on all 66 listing pages → zero galleries.
- **On a listing PAGE the price is `listingSummary.displayPrice`.**
  `listingSummary.price` is not a string there, so a pass came back with every
  price empty and could not confirm sold-by-page. The search feed's
  `listingModel.price` IS a string. Fall through both.

The standing search the call pages through:

```
https://www.domain.com.au/sale/?suburb=point-cook-vic-3030,williams-landing-vic-3027,torquay-vic-3228,seabrook-vic-3028&bedrooms=3-any&bathrooms=2-any&carspaces=1-any&price=600000-1100000&ssubs=0
```

Search pages are WAF-tolerant — page them rapidly (1.3s); listing pages are not
(step 3). **Missing listings go to Domain's `/sold-listings/` search first** —
also WAF-tolerant at 1.3s, and it gives the sold price AND the real sale date
("Sold by private treaty 07 Sep 2026"); 23 of 55 missing resolved there one run.
Only what it cannot resolve gets a page fetch, by bare id `domain.com.au/<id>`,
which redirects either to the listing or to `/property-profile/` = withdrawn.

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

**In the one-call round this already happened** — the pass is the tail of the
step 1 call and `_domain-round-split.mjs` has written `pass-1.json`. Skip
straight to `_pass-apply-live.mjs` below. `_pass-targets.mjs` chunks a pass for
the two-popup fallback path only:

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
  --file=<{images: [...gallery]}> --chunk=3        # images section — SLOW, chunk it
```

**`_pass-apply-live.mjs` writes `_gallery-<name>.json` as a BARE ARRAY, not a
batch payload.** Pushing that file directly matches no section, and `/api/batch`
answers `{"ok":true,"errors":0}` having stored nothing — the push looks perfect
and `image_count` stays 0. Wrap it first: `{images: [...that array]}`. Always
confirm a gallery push by re-reading `image_count`, never by its exit status.

Dedupe on **basename**, not `source_url`: Domain re-signs every URL per capture,
so `syncImages` cannot tell a re-harvest from a new photo and will store the
gallery twice. The live snapshot gives `image_count` but not basenames, so the
only safe rule over HTTP is the one `_pass-apply-live.mjs` enforces: **load a
gallery only for a property at zero photos**, and report the rest rather than
guessing. It also drops what the app would never render anyway — squares,
banner strips, sub-500px icons, read off the `-w<W>-h<H>` basename. Those come
in via the page-HTML source and then sit permanently untagged, because the
property page never lists them for the tagger to reach.

**Guard every pass file before you push it.** `data/harvest/pass-*.json` is
gitignored and persists between rounds. A half-updated splitter once wrote a
retry to `pass-1`, so `_pass-apply-live.mjs pass-2` read a STALE pass file and
re-marked 8 already-sold properties — and `markSold` with no `date` resets their
`Sold` row to today, destroying the real sale dates. **Check the key count
matches this round's target count before any status push.**

**Never pipe a push script through `| head`** — SIGPIPE can kill it mid-run,
leaving a partial apply that looks like a completed one.

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

**Some gallery slots are GIFs**, often the floorplan at a late ordinal. The
tagger tries `webp/gif/jpg/png` against `/api/img/<pid>/<id>.<ext>`; an `img 404`
from it means the wrong extension was guessed, not a missing file.

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

Two traps in these two, both of which survive a clean-looking run:

- **They import `src/db/client` even under `PROPS_JSON`, and opening that client
  auto-MIGRATES the local `data/app.db`** (schema only, no rows). Run
  `git checkout -- data/app.db` afterwards so the tracked snapshot stays put.
- **On an Overpass 504 they refuse to write**, leaving LAST round's
  `_*-new.json` in place — and pushing those silently applies stale enrichment
  (done once, 15 Aug's files). Delete the `_*-new.json` files before running and
  check the row set matches this round's `_new.json` before pushing.

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

Fallback: `_transit-estimate.ts` (nearest measured neighbour, zone-split so
Torquay never borrows a Point Cook time). **`--apply` writes the LOCAL DB — do
not use it here.** Emit a payload with `OUT_JSON=` and push that to `.125`
instead. It is
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

## 9. The REA half (realestate.com.au)

Committed scripts as of 2026-09-06. Same live app, same `/api/batch`, same
read-only rule on the local DB.

```bash
node scripts/_receiver.mjs &                 # already running from step 0
node scripts/_snapshot-live.mjs              # RE-baseline: the Domain half just inserted
```

1. `scripts/browser/rea-search-harvest.js` — one JS call, ~30 pages, ~3 min.
2. `npx tsx scripts/_rea-diff.ts` → `_rea-pass.json` / `_rea-price.json` / `_rea-sold.json`.
3. `scripts/browser/rea-listing-pass.js` with the pass URLs (3s spacing).
4. `npx tsx scripts/_rea-ingest.ts` → push `properties`, then `images --chunk=3`.
5. `npx tsx scripts/_tag-remote-rea.ts`, THEN `node scripts/_rea-floorplan-mark.mjs`.
6. geocode → `compute-stations` → `compute-metadata` → `_alt-new-live.mjs` → transit.
7. `node scripts/_verify-live.mjs`.

**REA does NOT bot-wall a same-origin `fetch`** — unlike Domain. Search and
listing pages both come back as full server HTML from a `fetch` on an REA tab,
so no iframe and no page-driving. That is why REA tolerates 3s and needs no
45s pacing.

**The full gallery is in the server HTML** even though the DOM lazy-loads ~4
images: GraphQL `MediaImage` / `MediaFloorplan` nodes with a `{size}`-templated
CDN URL. `MediaFloorplan` is its own typename, so **REA floorplans are known,
not guessed** — strictly better than Domain's last-position heuristic.

Traps that have each cost real time:

- **Card text is `textContent`, so fields run together** (`$1,100,0001 Frankie
  Way`). Price must require comma-grouped thousands; the address needs the
  price-run end as a lower bound, and a `\d{1,5}` cap on the street number or
  an agent's mobile becomes one.
- **`body.textContent` includes `<style>`** and REA opens with KB of inline CSS
  — strip `script`/`style` or every listing normalizes as "no price".
- **Bridge home gzipped through the receiver's landing page**
  (`http://127.0.0.1:3300/#name=<file>&d=<gzip+base64>`), which strips the
  fragment itself. A raw payload in a fragment gets echoed into tool output and
  cost ~45K tokens once. 2026-09-14: harvesting under `#MOMDGZ=` reads as "no
  payload" — it must be `#name=...&d=...`.
- **The local vision model and Google Maps cannot run at once.** Tagging
  saturates the GPU and Chrome's Maps renderer freezes hard (CDP evaluate times
  out at 45s). Tag first, measure transit after.
- **Price moves on Domain-held rows are reported, not pushed** — REA's wording
  on a Domain row flip-flops every round. **This holds only while the row is
  still live on Domain** — see the source-of-truth rule below.

REA's JS permission behaves like Domain's (see "Before you start"): grant it
once for realestate.com.au and the four calls above run without re-prompting.
The half nominally costs 4 prompts (navigate, search, navigate back, pass)
because the diff needs the live baseline computed in node between the two JS
calls.

## 10. When a row leaves Domain but lives on REA

**A property that is no longer on Domain but is still listed for sale on REA is
an REA row now, whatever it was captured as.** Stated 2026-09-20. REA becomes
the source of truth for its price and status — the "report, don't push" rule
above applies only while Domain still carries the listing.

The classification, per row missing from this round's Domain feed:

| Domain | REA buy | REA sold | Verdict |
| --- | --- | --- | --- |
| relisted under a new id | — | — | still a Domain row; the OLD row's withdrawal is correct |
| absent | listed | no | **REA is truth** — push REA price, leave it live |
| absent | no | listed | sold; REA corroborates the Domain sold record |
| absent | no | no | gone from both; leave the status the pass derived |

Three things this rule does NOT do:

- **It does not beat a dated Domain sale.** A Domain `/sold-listings/` hit
  carries a real settlement date; a stale REA buy card that the agent never
  pulled down does not outrank it. Check REA's SOLD list before treating an REA
  buy listing as proof a property is still for sale — 2026-09-20, four rows
  looked like live REA price moves and were on REA's own sold list. REA
  corroborated 11 of that round's 12 Domain sales.
- **It does not repoint the link.** Push the HELD row's `listing_url` (the
  domain.com.au one), never the REA URL — see the link rule in "Before you
  start". `properties` upserts by `listing_url`, so pushing the REA link would
  repoint the row.
- **It does not mean "push every REA price".** Diff first: most REA-only rows
  already carry the right price and need no write at all (1 of 2 in the round
  that established this).

**Matching addresses between the two sources — the trap.** Match the Domain feed
on street number + street-name stem (`9 yarkon`), but match the REA side by
**containment in the card text**, never by a leading-number regex: REA card text
is `textContent` with the fields run together, so the agent's name or the price
sits where the street number should be and a leading-number match silently reads
the wrong token. Getting this wrong made 6 rows look REA-only when only 2 were,
and hid `93 Shaftsbury Bvd` vs `93 Shaftsbury Boulevard` behind an abbreviation.

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
