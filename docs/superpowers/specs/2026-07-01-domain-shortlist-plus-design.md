# Domain Shortlist+ — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)

A Manifest V3 Chrome extension that enhances two pages on `domain.com.au`: the
user's **shortlist** (`/user/shortlist`) and any **map search** view
(`…?displaymap=1`). It adds sorting, a local star rating, notes display, and
carries the user's shortlist notes into the map view.

All enhancements are built on data Domain already ships to the page, plus a
small amount of extension-owned local state.

---

## Goals

1. Sort the shortlist by: **date listed**, **date shortlisted**, **price**,
   **my rating**, **price reduction** (asc/desc where meaningful).
2. Show each property's **notes** on its shortlist card: clamped to **4 lines**
   by default, a **global toggle** to collapse/expand-to-4-lines for all cards,
   and **hover reveals the full note**.
3. **Persist** the chosen sort (and the notes toggle state) across visits —
   back-navigation, fresh load, or SPA route change.
4. On any **map view** (`displaymap=1`), show the shortlist notes for a property
   when its card/info-window is displayed.

## Non-goals (v1)

- Syncing ratings across devices (local storage only).
- Editing Domain notes from the extension (Domain owns note editing).
- Any server/backend of our own.

---

## Data sources

### 1. Page-embedded data — `__NEXT_DATA__` (read-only)

Domain is a Next.js app; the shortlist page embeds the full list at
`props.pageProps.componentProps.shortlistListings` (array). Confirmed per-item
fields we use:

| Field | Use |
|-------|-----|
| `id` (number) | listing id — the join key everywhere |
| `notes` (string \| null) | notes display |
| `price` (number) | price sort |
| `displayPrice` (string) | shown as-is when needed |
| `datePlaced` (ISO) | **date listed** sort |
| `dateShortlisted` (ISO) | **date shortlisted** sort |
| `features` `{beds,baths,parking}` | (available; not sorted in v1) |
| `address`, `url` | display / id parsing |

A content script reads this by parsing
`document.getElementById('__NEXT_DATA__').textContent` — no page-context
injection needed to read it.

### 2. Price-change data — Domain "shortlist perk" via GraphQL

Domain shows **"Price last month"** vs **"Current price"** for shortlisted
listings — explicitly labelled *"Price changes are a shortlist only perk"*. This
is **not** in `__NEXT_DATA__`; it is fetched client-side via
`POST https://www.domain.com.au/graphql` (a persisted query) on the listing
detail page, authenticated by the user's existing cookies.

The extension reuses this real Domain data for the **price-reduction sort**:
- "Reduced" = current price < previous ("last month") price.
- Fetched per listing id, **on demand** (only when the price-reduction sort is
  selected) and **cached** in `chrome.storage.local` with a timestamp.

**Discovering the exact call:** the operation name, persisted-query hash, and
variable shape are captured from the page's own request during implementation
(see Open Questions). The content script then issues the same
same-origin `fetch` with `credentials:'include'`. If Domain rotates the hash, a
fallback observes the page's live call to relearn it.

### 3. Extension-owned state — `chrome.storage.local`

| Key | Shape | Purpose |
|-----|-------|---------|
| `ratings` | `{ [listingId]: 0–5 }` | local star rating (rating sort) |
| `priceChangeCache` | `{ [listingId]: {current, previous, at} }` | cached perk data |
| `notesCache` | `{ [listingId]: string }` | notes captured on shortlist visits, read by the map view |
| `sortPref` | `{ key, dir }` | persisted sort |
| `notesExpanded` | `boolean` | persisted global notes toggle |

`notesCache` is refreshed every shortlist visit and is what makes notes appear
in the map view (which has no access to the shortlist payload).

---

## Architecture

Manifest V3, no build step required beyond bundling (plain JS + CSS).

```
manifest.json
  content_scripts:
    - matches: ["*://www.domain.com.au/user/shortlist*"]  → shortlist.js + styles.css
    - matches: ["*://www.domain.com.au/*"]                → map.js + styles.css
      (map.js self-gates on location.search containing displaymap=1)
  permissions: ["storage"]
  host_permissions: ["*://www.domain.com.au/*"]

src/
  storage.js   — thin async wrappers over chrome.storage.local (get/set per key)
  nextdata.js  — parse __NEXT_DATA__, return shortlistListings[]
  graphql.js   — fetch + cache price-change perk data by listingId
  shortlist.js — shortlist page: sort control, rating, notes UI, persistence
  map.js       — map view: inject notes from notesCache
  styles.css   — line-clamp, hover, rating, injected-control styles
```

### Shortlist page flow (`shortlist.js`)

On load **and** on re-render (see SPA handling):
1. Parse `shortlistListings` from `__NEXT_DATA__`; build `id → data` map.
2. Write each non-null `notes` into `notesCache` (for the map view).
3. For each card in the DOM, resolve its listing id (parse the card's link URL,
   which ends in the id, e.g. `…-2020791659`).
4. Inject, idempotently (guard with a `data-dsp` attribute):
   - a **star rating** control (reads/writes `ratings`);
   - a **notes block** showing `notes`, CSS-clamped to 4 lines.
5. Ensure the **sort control** and **global notes toggle** exist in the toolbar.
6. Apply the persisted sort and toggle state.

**Sorting** reorders cards via **CSS `order`** on the card grid/flex container
(each card gets an `order` value from its rank in the sorted list). This is
re-applied by the MutationObserver, so React re-renders don't lose it. If the
container turns out not to be flex/grid, fall back to DOM node reordering.
Chosen because it fights React's reconciliation the least. **Validated first**
(see Open Questions).

**Notes UI:**
- Default: clamp to 4 lines (`-webkit-line-clamp: 4`).
- Global toggle in the toolbar flips `notesExpanded`; collapsed state can hide
  notes entirely or show 4 lines (default = show 4 lines).
- **Hover** on a note shows the full text (CSS `:hover` expands / tooltip
  overlay). No JS needed for the hover reveal.

**Persistence:** `sortPref` and `notesExpanded` are read on load and written on
change. Because Domain is an SPA, we re-apply them on every (re-)entry to the
shortlist route, so returning via back/forward or in-app navigation restores the
user's view.

### Map view flow (`map.js`)

1. Gate: only run when `location.search` includes `displaymap=1`.
2. A MutationObserver watches for property cards / info-windows appearing.
3. For each, parse the listing id from its link URL, look it up in `notesCache`,
   and inject a notes block (same clamp + hover behaviour, shared CSS).
4. If a property isn't in `notesCache` (never seen on the shortlist), show
   nothing for it.

---

## SPA / React robustness (primary risk)

Domain is a React/Next.js SPA that re-renders and navigates client-side.
Mitigations, applied uniformly:

- **MutationObserver** (debounced) on the results container re-runs injection and
  re-applies sort/toggle after any re-render.
- **Idempotent injection:** every injected node is tagged (`data-dsp="…"`); we
  never double-inject.
- **Route changes:** wrap `history.pushState`/`replaceState` and listen for
  `popstate` to detect in-app navigation and re-run the entry logic.
- Content scripts run at `document_idle`; all logic tolerates the target DOM not
  existing yet and simply waits for the observer to fire.

---

## Error handling

- Missing/parse-failed `__NEXT_DATA__` → log once, no-op (page still works).
- GraphQL fetch failure/timeout → that listing has no price-change data; it sorts
  to the end of a price-reduction sort and the UI shows "—". Never blocks other
  features.
- Unknown listing id (no DOM match) → skip silently.
- All features are independent: one failing never breaks the others.

---

## Testing

No framework. Pure functions get tiny assert-based self-checks; DOM/React
behaviour is verified manually against the live site.

- **Unit (assert self-checks):** the comparators (date/price/rating/reduction,
  incl. null handling), listing-id-from-URL parser, and the "reduced?" predicate.
- **Manual smoke (live site):** load shortlist → each sort reorders correctly and
  survives a re-render; notes clamp/toggle/hover work; reload restores sort +
  toggle; back-navigation restores them; a `displaymap=1` URL shows notes on a
  known shortlisted property.

---

## Open questions to resolve early in implementation

1. **CSS `order` sorting works on the card container?** Validate on the live
   shortlist before building the rest of the sort UI. (Fallback: DOM reorder.)
2. **Exact GraphQL price-change operation** — capture operationName, persisted
   hash, and variables from the page's own `POST /graphql`, and the response
   path to the previous/current price values.
3. **Map card DOM shape** — confirm the selector for map result cards /
   info-windows and where the listing-id-bearing link is, on a live
   `displaymap=1` page.

These are inspection tasks against the live site, not design unknowns; each has a
stated fallback.

---

## Out of scope / future

- Price history beyond Domain's "last month vs current" (Domain exposes no more).
- Cross-device sync, options page, additional sort keys (beds, suburb).
