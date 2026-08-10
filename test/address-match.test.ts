// Cross-site address matching: an REA listing must attach to the existing
// Domain row for the same house, and must NOT merge two different houses.
// Runs as part of `npm test`.
import assert from "node:assert";
import { __addressKeyForTest as key } from "../src/scrape/persist";

const domain = { address: "5 Lafayette Cres, Point Cook, VIC, 3030", suburb: "Point Cook" };
const rea = { address: "5 Lafayette Crescent", suburb: "Point Cook" };
assert.strictEqual(key(domain), key(rea), "same house across sites must match");

// Abbreviation + punctuation + case differences all normalise away.
assert.strictEqual(
  key({ address: "12 Foo Street", suburb: "Point Cook" }),
  key({ address: "12 FOO ST.", suburb: "point cook" }),
);

// Different houses must stay distinct.
assert.notStrictEqual(
  key({ address: "5 Foo St", suburb: "Point Cook" }),
  key({ address: "6 Foo St", suburb: "Point Cook" }),
);
// A unit is not the house it sits in — this one bit us in the shortlist.
assert.notStrictEqual(
  key({ address: "4/275 Point Cook Rd", suburb: "Point Cook" }),
  key({ address: "275 Point Cook Rd", suburb: "Point Cook" }),
);
// Same street name and number, different suburb — the only thing the postcode
// used to contribute, and the suburb still covers it.
assert.notStrictEqual(
  key({ address: "5 Foo St", suburb: "Point Cook" }),
  key({ address: "5 Foo St", suburb: "Williams Landing" }),
);
// No address = no key, so a nameless scrape never merges into a random row.
assert.strictEqual(key({ address: null, suburb: "Point Cook" }), null);

// A capture that carries no postcode must still match the stored row. It used
// to key on the postcode too, so this listing silently became a SECOND row for
// the same house — with none of its ratings, notes or deduced metadata.
assert.strictEqual(
  key({ address: "5 Lafayette Cres", suburb: "Point Cook" }),
  key(domain),
  "missing postcode must not block the twin match",
);

console.log("address-match: all assertions passed");
