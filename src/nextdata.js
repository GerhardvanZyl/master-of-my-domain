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
