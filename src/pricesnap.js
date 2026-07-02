// src/pricesnap.js — local price snapshots (no Domain API).
// ponytail: baseline = first price THIS extension saw, not the true listing
// price. Domain doesn't expose price history on the shortlist page (zero
// graphql fires there), so "reduction since listing" means "reduction since you
// first viewed it here". Upgrade path: per-listing graphql fetch if true
// historical price is ever needed.

function parseSnapPrice(item) {
  if (typeof item.price === 'number' && item.price > 0) return item.price;
  const s = item.displayPrice || item.price || '';
  const m = String(s).replace(/,/g, '').match(/\d{4,}/); // first 4+ digit number
  return m ? Number(m[0]) : null;
}

// Update stored snapshots from the current listings, and return
// { [id]: {previous, current} } ready for enrichForSort / sortValue('reduction').
async function ensurePriceChanges(map) {
  const snaps = await DSP.get('priceSnapshots', {}); // { [id]: {first, last} }
  const changes = {};
  let dirty = false;
  for (const [id, item] of map) {
    const cur = parseSnapPrice(item);
    if (cur == null) continue;
    let snap = snaps[id];
    if (!snap) { snap = { first: cur, last: cur }; snaps[id] = snap; dirty = true; }
    else if (snap.last !== cur) { snap.last = cur; dirty = true; }
    changes[id] = { previous: snap.first, current: cur };
  }
  if (dirty) await DSP.set('priceSnapshots', snaps);
  return changes;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSnapPrice, ensurePriceChanges };
}
