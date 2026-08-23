/**
 * Unit tests for the property.com.au enrichment sanitizers — the tri-state
 * contract (`undefined` = not sent/malformed, `null` = explicit clear, value
 * = valid) that db/queries/load.ts relies on to keep a bad row from clobbering
 * a previously-good value on a partial update. See src/lib/property-com-au.ts.
 */
import assert from "node:assert/strict";
import {
  sanitizePropertyComAuUrl,
  sanitizeYearBuilt,
  isValidPropertyComAuUrl,
  propertyComAuSearchUrl,
} from "../src/lib/property-com-au";

const REAL_URL = "https://www.property.com.au/vic/point-cook-3030/villiers-dr/20-pid-9472083/";

// --- sanitizePropertyComAuUrl -----------------------------------------------

assert.equal(sanitizePropertyComAuUrl(REAL_URL), REAL_URL, "valid URL returned unchanged");

assert.equal(
  sanitizePropertyComAuUrl(REAL_URL.replace("https:", "http:")),
  undefined,
  "http:// (not https) is rejected",
);

assert.equal(
  sanitizePropertyComAuUrl("https://evil.example.com/vic/point-cook-3030/villiers-dr/20-pid-9472083/"),
  undefined,
  "wrong host entirely is rejected",
);

// Host-suffix confusion: a hostname that ENDS with the real host as a
// substring but isn't it — this is the security-relevant case, since a naive
// `.includes()`/`.endsWith()` check (instead of an exact hostname match)
// would let an attacker register a subdomain of their own domain that merely
// contains the real host as a suffix of its own labels.
assert.equal(
  sanitizePropertyComAuUrl("https://property.com.au.evil.com/pid-1/"),
  undefined,
  "host-suffix confusion (property.com.au.evil.com) is rejected",
);
assert.equal(
  sanitizePropertyComAuUrl("https://notwww.property.com.au/pid-1/"),
  undefined,
  "a different subdomain of the real domain is rejected — only www. is trusted",
);

// Userinfo confusion: "https://www.property.com.au@evil.com/" parses to
// hostname "evil.com" (the part before "@" is userinfo, not host) — the same
// class of bug as the suffix case above, caught by the same exact-hostname
// check rather than any string-prefix matching on the whole URL.
assert.equal(
  sanitizePropertyComAuUrl("https://www.property.com.au@evil.com/pid-1/"),
  undefined,
  "userinfo confusion (real host before an @ in front of evil.com) is rejected",
);

assert.equal(sanitizePropertyComAuUrl(""), undefined, "empty string -> undefined, not null");
assert.equal(sanitizePropertyComAuUrl("not a url at all"), undefined, "garbage -> undefined, not null");
assert.equal(
  sanitizePropertyComAuUrl(123 as unknown as string),
  undefined,
  "non-string -> undefined, not null",
);

// new URL() coerces its argument via toString() before parsing, so a
// single-element array that STRINGIFIES to a valid property.com.au URL would
// otherwise sail through the gate and be returned unchanged (the array
// itself, not a string) — reaching the SQLite binder, which throws on a
// non-primitive bind and 500s the whole batch. tech-002.
assert.equal(
  sanitizePropertyComAuUrl([REAL_URL] as unknown as string),
  undefined,
  "an array stringifying to a valid URL is rejected, not returned verbatim",
);

assert.equal(sanitizePropertyComAuUrl(null), null, "explicit null is an explicit clear, distinct from malformed");
assert.equal(sanitizePropertyComAuUrl(undefined), undefined, "undefined means not sent");

// --- isValidPropertyComAuUrl (render-path boolean) --------------------------

assert.equal(isValidPropertyComAuUrl(REAL_URL), true);
assert.equal(isValidPropertyComAuUrl(null), false);
assert.equal(isValidPropertyComAuUrl(undefined), false);
assert.equal(isValidPropertyComAuUrl("https://evil.example.com/"), false);

// --- sanitizeYearBuilt -------------------------------------------------------

const CURRENT_YEAR = new Date().getFullYear();

assert.equal(sanitizeYearBuilt(2008), 2008, "valid year returned unchanged");
assert.equal(sanitizeYearBuilt(0), undefined, "0 is rejected");
assert.equal(sanitizeYearBuilt(999), undefined, "999 is rejected");
assert.equal(sanitizeYearBuilt(3000), undefined, "3000 is rejected");
assert.equal(sanitizeYearBuilt(2008.5), undefined, "non-integer is rejected");

// The documented extraction path (a regex over the property.com.au page's
// embedded JSON — see notes.md) hands back its capture group as a STRING, so
// a numeric string must be accepted rather than silently dropped. tech-003(a).
assert.equal(
  sanitizeYearBuilt("2008" as unknown as number),
  2008,
  "a numeric string (the real regex-extraction shape) is accepted and coerced",
);
assert.equal(
  sanitizeYearBuilt("20a8" as unknown as number),
  undefined,
  "a non-numeric string is still rejected",
);
assert.equal(
  sanitizeYearBuilt("2008.5" as unknown as number),
  undefined,
  "a fractional string is still rejected",
);
assert.equal(sanitizeYearBuilt("" as unknown as number), undefined, "an empty string is still rejected");
assert.equal(
  sanitizeYearBuilt("3000" as unknown as number),
  undefined,
  "a numeric string still goes through the same range check",
);

// Boundaries: 1800 and currentYear+1 accepted, one step outside each rejected.
assert.equal(sanitizeYearBuilt(1800), 1800, "1800 is the accepted lower boundary");
assert.equal(sanitizeYearBuilt(1799), undefined, "1799 is one below the boundary — rejected");
assert.equal(sanitizeYearBuilt(CURRENT_YEAR + 1), CURRENT_YEAR + 1, "currentYear+1 is the accepted upper boundary");
assert.equal(sanitizeYearBuilt(CURRENT_YEAR + 2), undefined, "currentYear+2 is one above the boundary — rejected");

assert.equal(sanitizeYearBuilt(null), null, "explicit null is an explicit clear");
assert.equal(sanitizeYearBuilt(undefined), undefined, "undefined means not sent");

// --- propertyComAuSearchUrl (render-path fallback when there's no stored
// property.com.au URL — true for every row on the live app today) ----------

{
  const url = propertyComAuSearchUrl("20 Villiers Dr", "Point Cook", "VIC", "3030");
  assert.ok(url !== undefined, "a full address produces a search URL");
  const parsed = new URL(url as string);
  assert.equal(parsed.protocol, "https:", "always https");
  assert.equal(parsed.hostname, "www.google.com", "always google.com — content can't steer the destination");
  assert.equal(parsed.pathname, "/search");
  assert.equal(
    parsed.searchParams.get("q"),
    "site:property.com.au 20 Villiers Dr Point Cook VIC 3030",
    "query is the site-scoped search text, verbatim once decoded",
  );
}

assert.equal(
  propertyComAuSearchUrl(null, null, null, null),
  undefined,
  "no usable address text at all -> undefined, so the caller can omit the row",
);
assert.equal(
  propertyComAuSearchUrl("", "  ", null, undefined),
  undefined,
  "blank/whitespace-only fields count as no usable text",
);
assert.equal(
  propertyComAuSearchUrl(null, "Point Cook", null, null),
  "https://www.google.com/search?q=site%3Aproperty.com.au+Point+Cook",
  "a single usable field is still enough to build a search",
);

// Hostile address content must produce a harmless search, not escape the
// google.com/search destination or break the URL.
{
  const hostile = propertyComAuSearchUrl(
    '20 Villiers Dr & <script>#foo?javascript:alert(1)\nnewline"quote',
    "Point Cook",
    "VIC",
    "3030",
  );
  const parsed = new URL(hostile as string);
  assert.equal(parsed.protocol, "https:", "hostile address text can't change the protocol");
  assert.equal(parsed.hostname, "www.google.com", "hostile address text can't change the destination host");
  assert.equal(parsed.pathname, "/search", "hostile address text can't change the path");
  assert.ok(
    parsed.searchParams.get("q")?.includes("javascript:alert(1)"),
    "the hostile text survives only as inert, percent-decoded query text",
  );
}

console.log("✓ property-com-au.test: all assertions passed");
