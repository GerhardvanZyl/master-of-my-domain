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

// nulls (item 2 null priceChange, item 3 equal prices = not reduced) sort last
// even ascending: the only genuinely-reduced item (1) leads, nulls trail.
const redAsc = sortListings(items, 'reduction', 'asc');
assert.strictEqual(redAsc[0].id, 1);
assert.strictEqual(isReduced(redAsc.at(-1).priceChange), false);

console.log('lib.test.js: all assertions passed');
