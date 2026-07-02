// src/lib.js — pure helpers. No DOM, no chrome APIs.
function parseListingId(url) {
  if (!url) return null;
  const m = String(url).match(/-(\d{5,})(?:[/?#].*)?$/);
  return m ? Number(m[1]) : null;
}

// Search/map result cards carry the id directly: <li data-testid="listing-2020820314">.
function listingIdFromTestid(testid) {
  const m = String(testid || '').match(/^listing-(\d{5,})$/);
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
  module.exports = { parseListingId, listingIdFromTestid, isReduced, compareListings, sortListings, sortValue };
}
