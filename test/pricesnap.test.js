// test/pricesnap.test.js
const assert = require('node:assert');

// stub DSP (chrome.storage wrapper) with an in-memory store
const store = {};
global.DSP = {
  async get(key, fallback) { return key in store ? store[key] : fallback; },
  async set(key, value) { store[key] = value; },
};

const { parseSnapPrice, ensurePriceChanges } = require('../src/pricesnap.js');

// parseSnapPrice
assert.strictEqual(parseSnapPrice({ price: 850000 }), 850000);
assert.strictEqual(parseSnapPrice({ displayPrice: '$1,200,000' }), 1200000);
assert.strictEqual(parseSnapPrice({ displayPrice: 'Contact agent' }), null);

(async () => {
  const map = new Map([[1, { id: 1, price: 900000 }]]);

  // first view: baseline == current, no reduction
  let ch = await ensurePriceChanges(map);
  assert.deepStrictEqual(ch[1], { previous: 900000, current: 900000 });

  // price drops on a later view: previous keeps the baseline, current updates
  map.set(1, { id: 1, price: 820000 });
  ch = await ensurePriceChanges(map);
  assert.deepStrictEqual(ch[1], { previous: 900000, current: 820000 });
  assert.strictEqual(store.priceSnapshots[1].first, 900000);

  console.log('pricesnap.test.js: all assertions passed');
})();
