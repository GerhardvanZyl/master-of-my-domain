/**
 * Unit tests for src/lib/format.ts's propertyTitle() — the single rule being
 * enforced is "a raw listing URL must never be rendered as a property title"
 * (see .claude/review/runs/20260920-1449-bugfix/brief.md, ITEM 1). Every site
 * that renders a property title (PropertyGrid tile+row, compare, property
 * detail, VibesConfig) now goes through this one function, so a regression
 * here is a regression everywhere it's used.
 */
import assert from "node:assert/strict";
import { propertyTitle } from "../src/lib/format";

const LISTING_URL = "https://www.realestate.com.au/property-house-vic-seabrook-151867256";

// --- address present: it wins over everything else ---
assert.equal(
  propertyTitle({ address: "1 Real St, Somewhere VIC 3000", suburb: "Somewhere" }),
  "1 Real St, Somewhere VIC 3000",
  "a disclosed address is used as-is",
);

// --- address null, suburb present: falls back to suburb, not a URL ---
assert.equal(
  propertyTitle({ address: null, suburb: "Seabrook" }),
  "Seabrook",
  "address-withheld listing falls back to suburb",
);

// --- both null: the plain fallback string, never a URL ---
{
  const title = propertyTitle({ address: null, suburb: null });
  assert.equal(title, "Address not disclosed", "both address and suburb absent -> literal fallback string");
}

// --- the real caller shape: every actual call site passes a PropertyListItem,
// which always carries a non-null listingUrl. A mutation that moves the URL
// fallback one rung later (`p.address ?? p.suburb ?? p.listingUrl ?? "..."`)
// would pass every case above, since none of them ever supply a listingUrl for
// that branch to reach. This is the one that catches it.
{
  const title = propertyTitle({ address: null, suburb: null, listingUrl: LISTING_URL });
  assert.equal(
    title,
    "Address not disclosed",
    "a listingUrl on the input must never leak into the fallback, at any rung",
  );
}

// --- suburb omitted entirely (optional field) behaves the same as null ---
assert.equal(
  propertyTitle({ address: null }),
  "Address not disclosed",
  "an omitted (not just null) suburb still falls back to the literal string",
);

// --- the hard constraint: never render the listing URL as a title, in any branch ---
// This is what actually breaks if propertyTitle regresses to `address ?? listingUrl`
// (the pre-fix shape at PropertyGrid.tsx:394/578) — the fallback previously reached
// for the URL, so this must never equal or contain it, in the case that exercises
// that exact fallback (both address and suburb absent, the shape a withheld-address
// REA listing produces).
{
  const title = propertyTitle({ address: null, suburb: null });
  assert.notEqual(title, LISTING_URL, "fallback title is never the raw listing URL");
  assert.ok(!title.includes("http"), "fallback title never contains a URL fragment");
}

console.log("✓ format.test: all assertions passed");
