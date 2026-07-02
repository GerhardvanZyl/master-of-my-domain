// src/shortlist.js
function findCards() {
  return Array.from(document.querySelectorAll('[data-testid="listing-card-container"]'));
}

function cardListingId(card) {
  const a = card.querySelector('a[href*="domain.com.au/"], a[href^="/"]');
  return a ? parseListingId(a.getAttribute('href')) : null;
}

// wrapper-tall is the flex column that grows with content; appending here
// expands the tile and pushes the bottom-pinned (position:absolute) footer
// down. The inner details column is fixed-height + overflow:hidden, so
// inserting there clips our note and collides with the footer.
// ponytail: falls back to the card if Domain changes the markup.
function tileBody(card) {
  return card.querySelector('[data-testid="listing-card-wrapper-tall"]') || card;
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
      tileBody(card).appendChild(el);
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
        s.textContent = '☆';
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
      // stars go just above the notes (renderNotes runs first, so notes exist).
      const body = tileBody(card);
      const notes = card.querySelector('.dsp-notes[data-dsp="notes"]');
      notes ? body.insertBefore(wrap, notes) : body.appendChild(wrap);
    }
    paintStars(wrap, ratings[id] || 0);
  }
}

function paintStars(wrap, value) {
  wrap.querySelectorAll('.dsp-star').forEach(s => {
    const on = Number(s.dataset.value) <= value;
    s.textContent = on ? '★' : '☆'; // filled vs hollow so an empty rating still reads as 5 stars
    s.classList.toggle('on', on);
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

var sortKeys = [
  { value: 'dateShortlisted', label: 'Date shortlisted' },
  { value: 'datePlaced',      label: 'Date listed' },
  { value: 'price',           label: 'Price' },
  { value: 'rating',          label: 'My rating' },
  { value: 'reduction',       label: 'Price reduced' },
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
  const sorted = sortListings(Array.from(items.values()), key, dir);
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

  const priceChanges = await ensurePriceChanges(map); // local snapshots
  const pref = await DSP.get('sortPref', { key: 'dateShortlisted', dir: 'desc' });
  applySort(enrichForSort(map, ratings, priceChanges), pref.key, pref.dir);

  if (!dspBootstrapped) { dspBootstrapped = true; startObserver(); hookSpaNav(); }
}

runShortlist();
