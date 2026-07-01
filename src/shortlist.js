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
