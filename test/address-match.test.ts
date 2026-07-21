// Cross-site address matching: an REA listing must attach to the existing
// Domain row for the same house, and must NOT merge two different houses.
// Run: npx tsx test/address-match.test.ts
import assert from "node:assert";
import { __addressKeyForTest as key } from "../src/scrape/persist";

const domain = { address: "5 Lafayette Cres, Point Cook, VIC, 3030", suburb: "Point Cook", postcode: "3030" };
const rea = { address: "5 Lafayette Crescent", suburb: "Point Cook", postcode: "3030" };
assert.strictEqual(key(domain), key(rea), "same house across sites must match");

// Abbreviation + punctuation + case differences all normalise away.
assert.strictEqual(
  key({ address: "12 Foo Street", suburb: "Point Cook", postcode: "3030" }),
  key({ address: "12 FOO ST.", suburb: "point cook", postcode: "3030" }),
);

// Different houses must stay distinct.
assert.notStrictEqual(
  key({ address: "5 Foo St", suburb: "Point Cook", postcode: "3030" }),
  key({ address: "6 Foo St", suburb: "Point Cook", postcode: "3030" }),
);
// A unit is not the house it sits in — this one bit us in the shortlist.
assert.notStrictEqual(
  key({ address: "4/275 Point Cook Rd", suburb: "Point Cook", postcode: "3030" }),
  key({ address: "275 Point Cook Rd", suburb: "Point Cook", postcode: "3030" }),
);
// Same street name, different suburb/postcode.
assert.notStrictEqual(
  key({ address: "5 Foo St", suburb: "Point Cook", postcode: "3030" }),
  key({ address: "5 Foo St", suburb: "Williams Landing", postcode: "3027" }),
);
// No address = no key, so a nameless scrape never merges into a random row.
assert.strictEqual(key({ address: null, suburb: "Point Cook", postcode: "3030" }), null);

console.log("address-match: all assertions passed");
