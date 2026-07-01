# Domain Shortlist+ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 Chrome extension that adds sorting, a local star rating, and notes display to the Domain.com.au shortlist, and shows shortlist notes in the map view.

**Architecture:** No-bundler MV3 extension. Content scripts are listed in order and share one isolated-world global scope, so plain files define functions consumed by later files — no `import`/build step. Pure logic lives in `src/lib.js` (also `module.exports`-guarded so Node can unit-test it). DOM/React/GraphQL behaviour is verified manually against the live site.

**Tech Stack:** Vanilla JS (ES2020), CSS, Chrome MV3 APIs (`chrome.storage.local`), Node's built-in `assert` for unit tests. No dependencies, no bundler.

## Global Constraints

- Manifest V3 only. `permissions: ["storage"]`, `host_permissions: ["*://www.domain.com.au/*"]`.
- No third-party runtime dependencies. No build step — files load as-is.
- Content scripts run in the isolated world; they may read the page DOM (including the `__NEXT_DATA__` script tag) but cannot touch page JS variables.
- The join key across all data is the numeric Domain **listing id**.
- All injected DOM nodes carry a `data-dsp` attribute and injection is idempotent (never double-inject).
- Every feature is independent: a failure in one must never break the others.
- Target: `www.domain.com.au` shortlist (`/user/shortlist`) and any URL with `displaymap=1`.

---

### Task 1: Pure logic library (`src/lib.js`) + Node unit tests

The testable core: parse a listing id from a URL, sort listings by any key, decide if a price change is a reduction. No browser needed.

**Files:**
- Create: `src/lib.js`
- Create: `test/lib.test.js`

**Interfaces:**
- Produces (globals in browser; `module.exports` in Node):
  - `parseListingId(url: string): number | null` — last `-<digits>` group in the URL path.
  - `compareListings(a, b, key, dir): number` — `key ∈ {'datePlaced','dateShortlisted','price','rating','reduction'}`, `dir ∈ {'asc','desc'}`. `a`/`b` are objects `{id, price, datePlaced, dateShortlisted, rating, priceChange}` where `rating` is `0..5` and `priceChange` is `{current, previous} | null`. Nulls/missing always sort last regardless of `dir`.
  - `sortListings(items, key, dir): array` — stable sort using `compareListings`.
  - `isReduced(priceChange): boolean` — `priceChange && priceChange.current < priceChange.previous`.

- [ ] **Step 1: Write the failing tests**

```js
// test/lib.test.js
const assert = require('node:assert');
const { parseListingId, sortListings, isReduced } = require('../src/lib.js');

// parseListingId
assert.strictEqual(parseListingId('https://www.domain.com.au/20-villiers-drive-point-cook-vic-3030-2020820314'), 2020820314);
assert.strictEqual(parseListingId('/87-tom-roberts-parade-point-cook-vic-3030-2020791659'), 2020791659);
assert.strictEqual(parseListingId('https://www.domain.com.au/user/shortlist'), null);
assert.strictEqual(parseListingId(''), null);

// isReduced
assert.strictEqual(isReduced({ current: 850000, previous: 900000 }), true);
assert.strictEqual(isReduced({ current: 900000, previous: 900000 }), false);
assert.strictEqual(isReduced(null), false);

// sortListings: price asc/desc
const items = [
  { id: 1, price: 900000, datePlaced: '2026-04-01', dateShortlisted: '2026-06-01', rating: 3, priceChange: { current: 900000, previous: 950000 } },
  { id: 2, price: 800000, datePlaced: '2026-05-01', dateShortlisted: '2026-06-10', rating: 5, priceChange: null },
  { id: 3, price: 850000, datePlaced: '2026-03-01', dateShortlisted: '2026-06-05', rating: 0, priceChange: { current: 850000, previous: 850000 } },
];
assert.deepStrictEqual(sortListings(items, 'price', 'asc').map(x => x.id), [2, 3, 1]);
assert.deepStrictEqual(sortListings(items, 'price', 'desc').map(x => x.id), [1, 3, 2]);

// date listed (datePlaced) desc = newest first
assert.deepStrictEqual(sortListings(items, 'datePlaced', 'desc').map(x => x.id), [2, 1, 3]);
// date shortlisted asc
assert.deepStrictEqual(sortListings(items, 'dateShortlisted', 'asc').map(x => x.id), [1, 3, 2]);
// rating desc
assert.deepStrictEqual(sortListings(items, 'rating', 'desc').map(x => x.id), [2, 1, 3]);
// reduction: reduced ones first (id 1 reduced), non-reduced/null after
assert.deepStrictEqual(sortListings(items, 'reduction', 'desc')[0].id, 1);

// nulls sort last even when ascending: item 2 has null priceChange
assert.strictEqual(sortListings(items, 'reduction', 'asc').at(-1).id, 2);

console.log('lib.test.js: all assertions passed');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/lib.test.js`
Expected: FAIL — `Cannot find module '../src/lib.js'`.

- [ ] **Step 3: Implement `src/lib.js`**

```js
// src/lib.js — pure helpers. No DOM, no chrome APIs.
function parseListingId(url) {
  if (!url) return null;
  const m = String(url).match(/-(\d{5,})(?:[/?#].*)?$/);
  return m ? Number(m[1]) : null;
}

function isReduced(pc) {
  return !!(pc && typeof pc.current === 'number' && typeof pc.previous === 'number' && pc.current < pc.previous);
}

// Value used for ordering; null/undefined => null (always sorts last).
function sortValue(item, key) {
  switch (key) {
    case 'price': return typeof item.price === 'number' ? item.price : null;
    case 'rating': return typeof item.rating === 'number' ? item.rating : null;
    case 'datePlaced': return item.datePlaced ? Date.parse(item.datePlaced) : null;
    case 'dateShortlisted': return item.dateShortlisted ? Date.parse(item.dateShortlisted) : null;
    case 'reduction': {
      const pc = item.priceChange;
      if (!isReduced(pc)) return null;
      return pc.current - pc.previous; // negative; bigger drop = more negative
    }
    default: return null;
  }
}

function compareListings(a, b, key, dir) {
  const va = sortValue(a, key), vb = sortValue(b, key);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;   // nulls last
  if (vb === null) return -1;
  const cmp = va < vb ? -1 : va > vb ? 1 : 0;
  return dir === 'desc' ? -cmp : cmp;
}

function sortListings(items, key, dir) {
  // stable: decorate with index, sort, undecorate
  return items
    .map((item, i) => [item, i])
    .sort((x, y) => compareListings(x[0], y[0], key, dir) || (x[1] - y[1]))
    .map(pair => pair[0]);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseListingId, isReduced, compareListings, sortListings, sortValue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/lib.test.js`
Expected: `lib.test.js: all assertions passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib.js test/lib.test.js
git commit -m "feat: pure sort/parse helpers with node tests"
```

---

### Task 2: Extension scaffold — `manifest.json` + `storage.js`

Make the extension load in Chrome and give the rest of the code a tiny persistence layer.

**Files:**
- Create: `manifest.json`
- Create: `src/storage.js`
- Create: `README.md` (load instructions)

**Interfaces:**
- Produces (globals): `const DSP = { get, set }` where
  - `DSP.get(key, fallback): Promise<any>` — reads `chrome.storage.local[key]`, returns `fallback` if absent.
  - `DSP.set(key, value): Promise<void>`.
  - Keys used later: `ratings`, `priceChangeCache`, `notesCache`, `sortPref`, `notesExpanded`.

- [ ] **Step 1: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Domain Shortlist+",
  "version": "0.1.0",
  "description": "Sort your Domain shortlist, rate properties, and see your notes on the shortlist and map.",
  "permissions": ["storage"],
  "host_permissions": ["*://www.domain.com.au/*"],
  "content_scripts": [
    {
      "matches": ["*://www.domain.com.au/user/shortlist*"],
      "js": ["src/lib.js", "src/storage.js", "src/nextdata.js", "src/graphql.js", "src/shortlist.js"],
      "css": ["src/styles.css"],
      "run_at": "document_idle"
    },
    {
      "matches": ["*://www.domain.com.au/*"],
      "js": ["src/lib.js", "src/storage.js", "src/map.js"],
      "css": ["src/styles.css"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Create placeholder files so the manifest loads**

Create empty `src/nextdata.js`, `src/graphql.js`, `src/shortlist.js`, `src/map.js`, `src/styles.css` (each with a one-line comment). These get filled by later tasks; the manifest references them now so Chrome loads cleanly.

```js
// src/nextdata.js — filled in Task 3
```
```js
// src/graphql.js — filled in Task 7
```
```js
// src/shortlist.js — filled in Tasks 4-7
```
```js
// src/map.js — filled in Task 8
```
```css
/* src/styles.css — filled in Task 4 */
```

- [ ] **Step 3: Implement `src/storage.js`**

```js
// src/storage.js — thin async wrapper over chrome.storage.local
const DSP = {
  get(key, fallback) {
    return new Promise(resolve => {
      chrome.storage.local.get(key, obj =>
        resolve(Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback));
    });
  },
  set(key, value) {
    return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
  },
};
```

- [ ] **Step 4: Write `README.md` load instructions**

```markdown
# Domain Shortlist+

Unpacked Chrome extension. To load:
1. Visit `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open https://www.domain.com.au/user/shortlist (logged in).

Run unit tests: `node test/lib.test.js`
```

- [ ] **Step 5: Manual verification**

Load the unpacked extension at `chrome://extensions`. Expected: no errors on the card, extension appears. Open the shortlist page; DevTools console shows no extension errors. In the console run `chrome` — confirm no manifest load warnings.

- [ ] **Step 6: Commit**

```bash
git add manifest.json src/ README.md
git commit -m "feat: MV3 scaffold + storage wrapper"
```

---

### Task 3: Read shortlist data from the page (`src/nextdata.js`)

Parse `shortlistListings` out of `__NEXT_DATA__` and expose it keyed by id.

**Files:**
- Modify: `src/nextdata.js`

**Interfaces:**
- Consumes: `parseListingId` (Task 1).
- Produces (globals):
  - `getShortlistListings(): Array<{id, notes, price, displayPrice, datePlaced, dateShortlisted, features, address, url}>` — parsed from the page, or `[]` on any failure.
  - `getShortlistMap(): Map<number, object>` — same data keyed by `id`.

- [ ] **Step 1: Implement `src/nextdata.js`**

```js
// src/nextdata.js — read Domain's embedded shortlist data
function getShortlistListings() {
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return [];
    const data = JSON.parse(el.textContent);
    const list = data?.props?.pageProps?.componentProps?.shortlistListings;
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[DSP] could not parse __NEXT_DATA__', e);
    return [];
  }
}

function getShortlistMap() {
  const m = new Map();
  for (const item of getShortlistListings()) {
    if (item && typeof item.id === 'number') m.set(item.id, item);
  }
  return m;
}
```

- [ ] **Step 2: Manual verification on the live shortlist**

Reload https://www.domain.com.au/user/shortlist. In the DevTools console (the extension's isolated world isn't the default console context, so paste the function body directly to sanity-check the shape) confirm:

Run in console:
```js
JSON.parse(document.getElementById('__NEXT_DATA__').textContent)
  .props.pageProps.componentProps.shortlistListings.length
```
Expected: a number > 0 matching your shortlist size (~31). Spot-check one item has `id`, `notes`, `price`, `datePlaced`, `dateShortlisted`.

- [ ] **Step 3: Commit**

```bash
git add src/nextdata.js
git commit -m "feat: parse shortlistListings from __NEXT_DATA__"
```

---

### Task 4: Notes on shortlist cards — display, clamp, hover, global toggle (`src/shortlist.js` + `src/styles.css`)

Show each card's notes (4-line clamp, hover reveals full), plus a toolbar toggle that collapses/expands notes for all cards, persisted.

**Files:**
- Modify: `src/shortlist.js`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `getShortlistMap` (Task 3), `parseListingId` (Task 1), `DSP` (Task 2).
- Produces (globals):
  - `findCards(): HTMLElement[]` — all shortlist card containers on the page.
  - `cardListingId(card): number | null` — listing id for a card via its anchor href.
  - `getToolbar(): HTMLElement` — the injected toolbar (created once), returned for other tasks to add controls to.
  - `renderNotes(map)` — inject/update the notes block on each card.
  - `applyNotesExpanded(expanded: boolean)` — toggle a body-level class.
  - `runShortlist()` — top-level entry that (re)applies all shortlist enhancements; called on load and by the observer (wired fully in Task 6). In this task it calls `renderNotes` + `applyNotesExpanded`.

- [ ] **Step 1: CSS in `src/styles.css`**

```css
/* Domain Shortlist+ */
.dsp-notes {
  font-size: 13px;
  line-height: 1.35;
  color: #333;
  margin: 6px 0 2px;
  white-space: pre-wrap;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;         /* default: 4 lines */
  cursor: help;
}
/* collapsed = hidden entirely */
body.dsp-notes-collapsed .dsp-notes { display: none; }
/* hover reveals full note regardless of clamp */
.dsp-notes:hover {
  -webkit-line-clamp: unset;
  display: block;
  background: #fffbe6;
  border-radius: 4px;
  padding: 4px 6px;
  position: relative;
  z-index: 5;
}
.dsp-notes:empty { display: none; }

.dsp-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 8px 0;
  font-size: 13px;
}
.dsp-toolbar button, .dsp-toolbar select {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}
.dsp-stars { display: inline-flex; gap: 2px; margin: 4px 0; }
.dsp-star { cursor: pointer; font-size: 16px; line-height: 1; color: #ccc; }
.dsp-star.on { color: #f5a623; }
```

- [ ] **Step 2: Implement notes + toggle in `src/shortlist.js`**

```js
// src/shortlist.js
function findCards() {
  return Array.from(document.querySelectorAll('[data-testid="listing-card-container"]'));
}

function cardListingId(card) {
  const a = card.querySelector('a[href*="domain.com.au/"], a[href^="/"]');
  return a ? parseListingId(a.getAttribute('href')) : null;
}

function getToolbar() {
  let bar = document.querySelector('.dsp-toolbar[data-dsp="toolbar"]');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.className = 'dsp-toolbar';
  bar.setAttribute('data-dsp', 'toolbar');
  // place above the first card's list container
  const firstCard = findCards()[0];
  const anchor = firstCard ? firstCard.parentElement : document.querySelector('main') || document.body;
  anchor.parentElement ? anchor.parentElement.insertBefore(bar, anchor) : anchor.prepend(bar);
  return bar;
}

function renderNotes(map) {
  for (const card of findCards()) {
    const id = cardListingId(card);
    const item = id != null ? map.get(id) : null;
    const notes = item && item.notes ? item.notes : '';
    let el = card.querySelector('.dsp-notes[data-dsp="notes"]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'dsp-notes';
      el.setAttribute('data-dsp', 'notes');
      card.appendChild(el);
    }
    if (el.textContent !== notes) el.textContent = notes; // idempotent
    el.title = notes; // native tooltip fallback
  }
}

function applyNotesExpanded(expanded) {
  document.body.classList.toggle('dsp-notes-collapsed', !expanded);
}

async function ensureNotesToggle() {
  const bar = getToolbar();
  if (bar.querySelector('[data-dsp="notes-toggle"]')) return;
  const btn = document.createElement('button');
  btn.setAttribute('data-dsp', 'notes-toggle');
  const expanded = await DSP.get('notesExpanded', true);
  const label = () => (document.body.classList.contains('dsp-notes-collapsed') ? 'Show notes' : 'Hide notes');
  applyNotesExpanded(expanded);
  btn.textContent = label();
  btn.addEventListener('click', async () => {
    const now = document.body.classList.contains('dsp-notes-collapsed'); // currently collapsed?
    applyNotesExpanded(now);            // if collapsed -> expand
    await DSP.set('notesExpanded', now);
    btn.textContent = label();
  });
  bar.appendChild(btn);
}

async function runShortlist() {
  const map = getShortlistMap();
  if (!map.size) return;
  await ensureNotesToggle();
  renderNotes(map);
}

runShortlist();
```

- [ ] **Step 3: Manual verification on the live shortlist**

Reload the shortlist. Expected:
- Notes appear under cards that have notes, clamped to 4 lines.
- Hovering a long note reveals the full text on a highlighted background.
- A toolbar with a **Hide notes / Show notes** button appears; clicking toggles all notes.
- Reload → the toggle state is remembered.

- [ ] **Step 4: Commit**

```bash
git add src/shortlist.js src/styles.css
git commit -m "feat: shortlist notes display, clamp, hover, persisted toggle"
```

---

### Task 5: Local star rating + notes cache (`src/shortlist.js`)

Add a 0–5 star control per card stored in `chrome.storage.local`, and cache notes by id so the map view can read them.

**Files:**
- Modify: `src/shortlist.js`

**Interfaces:**
- Consumes: `findCards`, `cardListingId` (Task 4), `DSP` (Task 2), `getShortlistMap` (Task 3).
- Produces (globals):
  - `renderStars(ratings)` — inject/update a star control per card; clicking writes `ratings[id]` via `DSP.set('ratings', …)`.
  - `cacheNotes(map)` — write `{ [id]: notes }` for non-empty notes into `notesCache`.
  - Updates `runShortlist()` to call both, and to attach `rating` + `priceChange` onto the objects used for sorting in Task 6.

- [ ] **Step 1: Implement stars + notes cache**

```js
// Append to src/shortlist.js

async function renderStars(ratings) {
  for (const card of findCards()) {
    const id = cardListingId(card);
    if (id == null) continue;
    let wrap = card.querySelector('.dsp-stars[data-dsp="stars"]');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'dsp-stars';
      wrap.setAttribute('data-dsp', 'stars');
      for (let i = 1; i <= 5; i++) {
        const s = document.createElement('span');
        s.className = 'dsp-star';
        s.textContent = '★';
        s.dataset.value = String(i);
        s.addEventListener('click', async (e) => {
          e.preventDefault(); e.stopPropagation();
          const current = await DSP.get('ratings', {});
          const val = Number(s.dataset.value);
          current[id] = current[id] === val ? 0 : val; // click same star again clears
          await DSP.set('ratings', current);
          paintStars(wrap, current[id]);
        });
        wrap.appendChild(s);
      }
      // insert stars above notes
      const notes = card.querySelector('.dsp-notes[data-dsp="notes"]');
      notes ? card.insertBefore(wrap, notes) : card.appendChild(wrap);
    }
    paintStars(wrap, ratings[id] || 0);
  }
}

function paintStars(wrap, value) {
  wrap.querySelectorAll('.dsp-star').forEach(s => {
    s.classList.toggle('on', Number(s.dataset.value) <= value);
  });
}

async function cacheNotes(map) {
  const cache = await DSP.get('notesCache', {});
  let changed = false;
  for (const [id, item] of map) {
    if (item.notes) { if (cache[id] !== item.notes) { cache[id] = item.notes; changed = true; } }
    else if (cache[id]) { delete cache[id]; changed = true; }
  }
  if (changed) await DSP.set('notesCache', cache);
}
```

- [ ] **Step 2: Update `runShortlist()` to call them**

Replace the existing `runShortlist` with:

```js
async function runShortlist() {
  const map = getShortlistMap();
  if (!map.size) return;
  await ensureNotesToggle();
  renderNotes(map);
  const ratings = await DSP.get('ratings', {});
  await renderStars(ratings);
  await cacheNotes(map);
}
```

- [ ] **Step 3: Manual verification**

Reload the shortlist. Expected:
- Each card shows 5 stars above its notes.
- Clicking a star fills 1–N; clicking the same star again clears to 0.
- Reload → ratings persist.
- In DevTools: `chrome.storage.local.get(['ratings','notesCache'], console.log)` shows both populated.

- [ ] **Step 4: Commit**

```bash
git add src/shortlist.js
git commit -m "feat: local star rating + notes cache"
```

---

### Task 6: Sort control + DOM reorder + SPA re-apply (`src/shortlist.js`)

Add the sort dropdown (excluding reduction, added in Task 7), reorder cards in the DOM, persist the choice, and keep everything applied through React re-renders and in-app navigation.

**Files:**
- Modify: `src/shortlist.js`

**Interfaces:**
- Consumes: `sortListings` (Task 1), `findCards`, `cardListingId`, `getToolbar` (Task 4), `getShortlistMap` (Task 3), `DSP` (Task 2).
- Produces (globals):
  - `enrichForSort(map, ratings, priceChanges): Map<number,object>` — merges `rating` and `priceChange` onto each item for the comparators. (`priceChanges` is `{}` until Task 7.)
  - `applySort(items, key, dir)` — reorder card DOM nodes to match sorted `items`, idempotently.
  - `ensureSortControl()` — inject the `<select>` for key + a direction button; persist to `sortPref`.
  - `sortKeys` — array of `{value,label}` sort options (reduction appended in Task 7).
  - Rewrites `runShortlist()` and adds `startObserver()` + SPA hooks.

- [ ] **Step 1: Implement sort + reorder + observer**

```js
// Append to / update src/shortlist.js

var sortKeys = [
  { value: 'dateShortlisted', label: 'Date shortlisted' },
  { value: 'datePlaced',      label: 'Date listed' },
  { value: 'price',           label: 'Price' },
  { value: 'rating',          label: 'My rating' },
  // 'reduction' appended in Task 7
];

function enrichForSort(map, ratings, priceChanges) {
  const out = new Map();
  for (const [id, item] of map) {
    out.set(id, {
      ...item,
      rating: ratings[id] || 0,
      priceChange: priceChanges[id] || null,
    });
  }
  return out;
}

function currentOrderIds() {
  return findCards().map(cardListingId);
}

function applySort(items, key, dir) {
  const sorted = sortListings(items, key, dir);
  const desired = sorted.map(x => x.id);
  const current = currentOrderIds();
  // idempotent: only touch DOM if order differs (prevents observer loop)
  if (desired.length === current.length && desired.every((id, i) => id === current[i])) return;

  const cards = findCards();
  const byId = new Map(cards.map(c => [cardListingId(c), c]));
  const parent = cards[0] && cards[0].parentElement;
  if (!parent) return;
  for (const id of desired) {
    const card = byId.get(id);
    if (card) parent.appendChild(card); // re-append in sorted order
  }
}

async function ensureSortControl() {
  const bar = getToolbar();
  if (bar.querySelector('[data-dsp="sort"]')) return;
  const pref = await DSP.get('sortPref', { key: 'dateShortlisted', dir: 'desc' });

  const sel = document.createElement('select');
  sel.setAttribute('data-dsp', 'sort');
  for (const k of sortKeys) {
    const o = document.createElement('option');
    o.value = k.value; o.textContent = k.label;
    if (k.value === pref.key) o.selected = true;
    sel.appendChild(o);
  }
  const dirBtn = document.createElement('button');
  dirBtn.setAttribute('data-dsp', 'sort-dir');
  const dirLabel = () => (pref.dir === 'asc' ? '↑ Asc' : '↓ Desc');
  dirBtn.textContent = dirLabel();

  const commit = async () => { await DSP.set('sortPref', pref); runShortlist(); };
  sel.addEventListener('change', () => { pref.key = sel.value; commit(); });
  dirBtn.addEventListener('click', () => { pref.dir = pref.dir === 'asc' ? 'desc' : 'asc'; dirBtn.textContent = dirLabel(); commit(); });

  bar.prepend(dirBtn);
  bar.prepend(sel);
}

let dspObserver = null;
function startObserver() {
  if (dspObserver) return;
  const target = document.querySelector('main') || document.body;
  let scheduled = false;
  dspObserver = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; runShortlist(); }, 150); // debounce
  });
  dspObserver.observe(target, { childList: true, subtree: true });
}

// Detect SPA navigation so we re-run when returning to the shortlist route.
function hookSpaNav() {
  const fire = () => setTimeout(runShortlist, 200);
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { const r = orig.apply(this, a); fire(); return r; };
  }
  window.addEventListener('popstate', fire);
}
```

- [ ] **Step 2: Rewrite `runShortlist()` to apply sort, and bootstrap observer/nav**

Replace `runShortlist` and the bottom `runShortlist();` call with:

```js
let dspBootstrapped = false;
async function runShortlist() {
  if (!location.pathname.startsWith('/user/shortlist')) return;
  const map = getShortlistMap();
  if (!map.size) return;

  await ensureNotesToggle();
  await ensureSortControl();
  renderNotes(map);

  const ratings = await DSP.get('ratings', {});
  await renderStars(ratings);
  await cacheNotes(map);

  const priceChanges = await DSP.get('priceChangeCache', {}); // {} until Task 7
  const pref = await DSP.get('sortPref', { key: 'dateShortlisted', dir: 'desc' });
  applySort(enrichForSort(map, ratings, priceChanges), pref.key, pref.dir);

  if (!dspBootstrapped) { dspBootstrapped = true; startObserver(); hookSpaNav(); }
}

runShortlist();
```

- [ ] **Step 3: Manual verification on the live shortlist**

Reload. Expected:
- Toolbar has a sort dropdown (Date shortlisted / Date listed / Price / My rating) and a direction button.
- Changing sort reorders the cards; direction flips order.
- Rating sort orders by your stars (from Task 5).
- Scroll/lazy-render or trigger a re-render (e.g. resize) — the sort **stays applied** (observer re-sorts) and notes/stars aren't duplicated.
- Reload → sort key + direction restored.
- Navigate away and back (in-app) → enhancements reappear.

- [ ] **Step 4: Commit**

```bash
git add src/shortlist.js
git commit -m "feat: sort control, DOM reorder, observer + SPA re-apply"
```

---

### Task 7: Price-change data via GraphQL + reduction sort (`src/graphql.js`, `src/shortlist.js`)

Fetch Domain's "shortlist perk" price-change data per listing (cached, on demand) and enable the price-reduction sort.

**Files:**
- Modify: `src/graphql.js`
- Modify: `src/shortlist.js`

**Interfaces:**
- Consumes: `DSP` (Task 2), `isReduced` (Task 1).
- Produces (globals):
  - `fetchPriceChange(listingId): Promise<{current, previous, at} | null>` — returns cached value if fresh (< 12h), else fetches via `POST /graphql`, caches, returns. `null` on failure.
  - `ensurePriceChanges(ids): Promise<object>` — resolves `{ [id]: {current,previous,at} }` for the given ids (from cache/fetch), writes `priceChangeCache`.

**PREREQUISITE INSPECTION (Open Question 2):** Before coding, capture the real operation on a live listing page. In DevTools → Network → filter `graphql`, reload a **shortlisted** listing page, click the `POST` `graphql` row, and read its **Payload** and **Response**. Record:
- `operationName`, the persisted-query `sha256Hash` (in `extensions.persistedQuery`), and the `variables` shape (expect `{ listingId }` or `{ id }`).
- The response path to the previous ("last month") and current price numbers.

Fill the three marked constants below with the captured values. The prices Domain shows are ranges (e.g. `$850,000 - $930,000`); use the **lower bound** of each range as the comparable number (parse first integer from the string), so "reduced" means the lower bound dropped.

- [ ] **Step 1: Implement `src/graphql.js`**

```js
// src/graphql.js — Domain "shortlist perk" price-change data
// >>> Fill these three from the Network capture (see task prerequisite) <<<
const DSP_GQL_OP = '__FILL_OPERATION_NAME__';
const DSP_GQL_HASH = '__FILL_SHA256_HASH__';
// Given the raw GraphQL response object, return {previous, current} price strings, or null.
function dspExtractPrices(resp) {
  // >>> Adjust this path to match the captured response shape <<<
  // Example placeholder shape — REPLACE after inspection:
  const node = resp?.data?.listing?.priceChange;
  if (!node) return null;
  return { previous: node.previousPrice, current: node.currentPrice };
}

function dspLowerBound(priceStr) {
  if (typeof priceStr === 'number') return priceStr;
  const m = String(priceStr || '').replace(/,/g, '').match(/\d{4,}/);
  return m ? Number(m[0]) : null;
}

async function fetchPriceChange(listingId) {
  const cache = await DSP.get('priceChangeCache', {});
  const hit = cache[listingId];
  const fresh = hit && hit.at && (Date.now() - hit.at) < 12 * 3600 * 1000;
  if (fresh) return hit;

  try {
    const url = 'https://www.domain.com.au/graphql';
    const body = {
      operationName: DSP_GQL_OP,
      variables: { listingId: String(listingId) },
      extensions: { persistedQuery: { version: 1, sha256Hash: DSP_GQL_HASH } },
    };
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const json = await r.json();
    const prices = dspExtractPrices(json);
    if (!prices) return null;
    const val = {
      previous: dspLowerBound(prices.previous),
      current: dspLowerBound(prices.current),
      at: Date.now(),
    };
    cache[listingId] = val;
    await DSP.set('priceChangeCache', cache);
    return val;
  } catch (e) {
    console.warn('[DSP] price change fetch failed', listingId, e);
    return null;
  }
}

async function ensurePriceChanges(ids) {
  const out = {};
  await Promise.all(ids.map(async id => { out[id] = await fetchPriceChange(id); }));
  return out;
}
```

- [ ] **Step 2: Add the reduction sort option and lazy fetch in `src/shortlist.js`**

Append the reduction option and a hook that fetches price changes only when that sort is active:

```js
// Append to src/shortlist.js
sortKeys.push({ value: 'reduction', label: 'Price reduced' });

// Called from runShortlist when the active sort needs price-change data.
async function ensureReductionData(map) {
  const ids = Array.from(map.keys());
  const data = await ensurePriceChanges(ids); // fetches + caches
  return data;
}
```

Update `runShortlist()`'s price-change line so it fetches live data when the reduction sort is selected (replace the `const priceChanges = …` line):

```js
  const pref = await DSP.get('sortPref', { key: 'dateShortlisted', dir: 'desc' });
  let priceChanges = await DSP.get('priceChangeCache', {});
  if (pref.key === 'reduction') priceChanges = await ensureReductionData(map);
```

(Ensure the `applySort(...)` call still follows, using the updated `priceChanges`.)

Because Task 6 added `sortKeys.push` before the select is built, and the select is built once, reload is needed for the new option to appear — expected for a dev reload.

- [ ] **Step 3: Manual verification**

On a live listing page, capture the GraphQL op (prerequisite) and fill the constants. Then on the shortlist:
- Select **Price reduced**. Expected: a brief pause while ~31 GraphQL calls run, then cards with a genuine reduction (current lower-bound < previous lower-bound) sort to the top.
- In DevTools: `chrome.storage.local.get('priceChangeCache', console.log)` shows cached `{current,previous,at}` per id.
- Re-select within 12h → no refetch (served from cache).

- [ ] **Step 4: Commit**

```bash
git add src/graphql.js src/shortlist.js
git commit -m "feat: GraphQL price-change fetch + reduction sort"
```

---

### Task 8: Map view notes (`src/map.js`)

On any `displaymap=1` URL, show shortlist notes for properties using the `notesCache` populated by shortlist visits.

**Files:**
- Modify: `src/map.js`

**Interfaces:**
- Consumes: `parseListingId` (Task 1), `DSP` (Task 2). (`lib.js` + `storage.js` are loaded before `map.js` per the manifest.)
- Produces: self-contained; no exports.

**PREREQUISITE INSPECTION (Open Question 3):** On a live `displaymap=1` page (e.g. `https://www.domain.com.au/sale/point-cook-vic-3030/?bedrooms=4-any&displaymap=1`), inspect a result card / selected-property panel. Confirm:
- the selector for result cards / the selected-property info panel;
- that each contains an anchor whose href ends in the listing id.

Set `DSP_MAP_CARD_SELECTOR` below to the confirmed selector. The default targets the same `listing-card-container` testid used on the shortlist (search results reuse it); adjust if inspection shows otherwise.

- [ ] **Step 1: Implement `src/map.js`**

```js
// src/map.js — show shortlist notes on the map/search view
const DSP_MAP_CARD_SELECTOR = '[data-testid="listing-card-container"]'; // verify on live displaymap=1 page

function dspOnMapView() {
  return new URLSearchParams(location.search).has('displaymap')
    && new URLSearchParams(location.search).get('displaymap') === '1';
}

async function dspRenderMapNotes() {
  if (!dspOnMapView()) return;
  const cache = await DSP.get('notesCache', {});
  if (!cache || !Object.keys(cache).length) return;

  for (const card of document.querySelectorAll(DSP_MAP_CARD_SELECTOR)) {
    const a = card.querySelector('a[href*="domain.com.au/"], a[href^="/"]');
    const id = a ? parseListingId(a.getAttribute('href')) : null;
    const notes = id != null ? cache[id] : null;
    if (!notes) continue;
    let el = card.querySelector('.dsp-notes[data-dsp="map-notes"]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'dsp-notes';
      el.setAttribute('data-dsp', 'map-notes');
      card.appendChild(el);
    }
    if (el.textContent !== notes) el.textContent = notes;
    el.title = notes;
  }
}

if (dspOnMapView()) {
  dspRenderMapNotes();
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; dspRenderMapNotes(); }, 200);
  }).observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
  // re-run on SPA filter changes that keep displaymap=1
  window.addEventListener('popstate', () => setTimeout(dspRenderMapNotes, 250));
}
```

- [ ] **Step 2: Manual verification**

First visit the shortlist (to populate `notesCache`). Then open a `displaymap=1` search that includes a property you have notes on. Expected:
- Notes appear on that property's result card (4-line clamp, hover reveals full — shared CSS from Task 4).
- Properties without cached notes show nothing extra.
- Changing filters (keeping the map) re-injects notes on new cards.

- [ ] **Step 3: Commit**

```bash
git add src/map.js
git commit -m "feat: shortlist notes on the map view"
```

---

## Self-Review

**Spec coverage:**
- Sort by date listed / date shortlisted / price / rating → Tasks 1, 6. ✅
- Sort by price reduction (Domain perk data) → Tasks 1, 7. ✅
- Notes display, 4-line clamp, hover full, global toggle → Task 4. ✅
- Local star rating → Task 5. ✅
- Persist sort + toggle across visits/back/SPA nav → Tasks 4, 6. ✅
- Map view notes on `displaymap=1` via notesCache → Tasks 5 (cache write), 8 (read). ✅
- React/SPA robustness (observer, idempotent, route hooks) → Tasks 6, 8. ✅
- Storage schema (`ratings`, `priceChangeCache`, `notesCache`, `sortPref`, `notesExpanded`) → Tasks 2, 4–7. ✅
- Three open-question inspections → embedded as prerequisites in Tasks 6 (CSS-order risk removed via DOM reorder), 7, 8. ✅

**Placeholder scan:** The only intentional fill-ins are the GraphQL op/hash/response-path (Task 7) and the map card selector (Task 8) — both gated behind explicit live-site inspection steps with defaults, which is the correct treatment for values only obtainable from the running site. No vague "add error handling" steps.

**Type consistency:** `parseListingId`, `sortListings`, `isReduced`, `DSP.get/set`, `findCards`, `cardListingId`, `getToolbar`, `enrichForSort`, `fetchPriceChange`, `ensurePriceChanges`, `notesCache`/`ratings`/`priceChangeCache`/`sortPref`/`notesExpanded` keys used consistently across tasks.

**Note on sorting approach:** The spec proposed CSS `order` with DOM-reorder fallback; this plan uses **DOM reorder as primary** (Task 6) — simpler, layout-agnostic, and it eliminates the spec's #1 risk. Same observable behaviour.
