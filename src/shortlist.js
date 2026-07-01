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

async function runShortlist() {
  const map = getShortlistMap();
  if (!map.size) return;
  await ensureNotesToggle();
  renderNotes(map);
  const ratings = await DSP.get('ratings', {});
  await renderStars(ratings);
  await cacheNotes(map);
}

runShortlist();
