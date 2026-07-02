// src/map.js — show your saved notes on the map view (?displaymap=1).
// Notes come from notesCache, which the shortlist script populates. Runs on
// every domain page (manifest match), but no-ops unless displaymap=1 so it's
// cheap elsewhere.

function dspMapActive() {
  return new URLSearchParams(location.search).get('displaymap') === '1';
}

// Card container varies by view:
//   shortlist            -> [data-testid="listing-card-container"]
//   search/map rail      -> <li data-testid="listing-{id}">
//   map marker popup     -> [data-testid="listing-popup"] (id only in its <a href>)
function mapFindCards() {
  return Array.from(document.querySelectorAll('[data-testid="listing-card-container"], [data-testid^="listing-"]'))
    .filter(el => {
      const t = el.getAttribute('data-testid');
      return t === 'listing-card-container' || t === 'listing-popup' || /^listing-\d{5,}$/.test(t);
    });
}

function mapCardListingId(card) {
  const fromTestid = listingIdFromTestid(card.getAttribute('data-testid'));
  if (fromTestid != null) return fromTestid;
  const a = card.querySelector('a[href*="domain.com.au/"], a[href^="/"]');
  return a ? parseListingId(a.getAttribute('href')) : null;
}

async function renderMapNotes() {
  const cache = await DSP.get('notesCache', {});
  for (const card of mapFindCards()) {
    const id = mapCardListingId(card);
    const note = id != null ? cache[id] : null;
    let el = card.querySelector('.dsp-notes[data-dsp="notes"]');
    if (!note) { if (el) el.remove(); continue; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'dsp-notes';
      el.setAttribute('data-dsp', 'notes');
      const feat = card.querySelector('[data-testid="listing-card-features-wrapper"]');
      if (feat) feat.parentElement.insertBefore(el, feat.nextSibling);
      else card.appendChild(el); // ponytail: fallback if Domain changes card markup
    }
    if (el.textContent !== note) el.textContent = note; // idempotent
    el.title = note;
  }
}

let dspMapObserver = null;
function startMapObserver() {
  if (dspMapObserver) return;
  const target = document.querySelector('main') || document.body;
  let scheduled = false;
  dspMapObserver = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; runMap(); }, 150); // debounce
  });
  dspMapObserver.observe(target, { childList: true, subtree: true });
}

let dspMapBooted = false;
async function runMap() {
  if (!dspMapActive()) return;
  await renderMapNotes();
  if (!dspMapBooted) { dspMapBooted = true; startMapObserver(); }
}

// SPA nav: displaymap can toggle without a full reload.
function hookMapNav() {
  const fire = () => setTimeout(runMap, 200);
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { const r = orig.apply(this, a); fire(); return r; };
  }
  window.addEventListener('popstate', fire);
}

hookMapNav();
runMap();
