/**
 * Offline unit tests for the REAL Domain/REA adapters. The data path is now a
 * pure normalize(raw) — tested with raw fixtures, no browser. The anti-bot wall
 * check lives in readRawFromPage, tested with page.setContent().
 */
import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { DomainAdapter } from "../src/scrape/adapters/domain";
import { ReaAdapter } from "../src/scrape/adapters/rea";
import { ScrapeError } from "../src/scrape/adapters/base";
import { readRawFromPage } from "../src/scrape/extract";
import type { RawPageData } from "../src/scrape/types";

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const domainRaw: RawPageData = {
  url: "https://www.domain.com.au/5-domain-rd-suburbia-nsw-2000-2019555111",
  nextData: {
    props: {
      pageProps: {
        componentProps: {
          listingSummary: {
            listingId: "2019555111",
            displayPrice: "$900,000",
            bedrooms: 3,
            bathrooms: 2,
            carspaces: 1,
            propertyType: "House",
            displayAddress: "5 Domain Rd, Suburbia NSW 2000",
            suburb: "Suburbia",
            state: "NSW",
            postcode: "2000",
            landAreaSqm: 512,
            agentName: "Pat Agent",
            agencyName: "Domain Realty",
            description: "Charming home.",
          },
          media: [
            { url: "https://rimh2.domainstatic.com.au/aaa/2000x1500/1.jpg" },
            { url: "https://rimh2.domainstatic.com.au/bbb/2000x1500/2.jpg" },
          ],
          inspectionDetails: {
            inspections: [
              { openingHours: { begins: "2999-01-06T11:00:00+11:00" } },
              { openingHours: { begins: "2999-01-04T11:00:00+11:00" } },
            ],
          },
        },
      },
    },
  },
  jsonLd: [
    {
      "@type": "Residence",
      name: "5 Domain Rd, Suburbia NSW 2000",
      address: {
        addressLocality: "Suburbia",
        addressRegion: "NSW",
        postalCode: "2000",
      },
    },
  ],
};

// Ground truth: a real captured realestate.com.au listing payload (see brief
// .claude/review/runs/2026-08-31-rea-source/brief.md). Read from disk rather
// than duplicated inline so it can't drift from what was actually captured.
const REA_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/rea-listing.json", import.meta.url),
);
const reaFixtureRaw = JSON.parse(
  fs.readFileSync(REA_FIXTURE_PATH, "utf8"),
) as RawPageData;

/** Minimal REA-shaped payload carrying only an address + the given Event blocks' startDates. */
function reaEventsPayload(startDates: string[]): RawPageData {
  return {
    url: "https://www.realestate.com.au/property-house-vic-events-111111111",
    jsonLd: [
      {
        "@type": "Residence",
        address: {
          "@type": "PostalAddress",
          streetAddress: "1 Events St",
          addressLocality: "Eventsville",
          addressRegion: "VIC",
          postalCode: "3000",
        },
      },
      ...startDates.map((startDate) => ({ "@type": "Event", startDate })),
    ],
  };
}

/** Minimal REA-shaped payload carrying only an address + the given aria-labels. */
function reaAriaPayload(ariaLabels: string[]): RawPageData {
  return {
    url: "https://www.realestate.com.au/property-house-vic-testville-999999999",
    jsonLd: [
      {
        "@type": "Residence",
        address: {
          "@type": "PostalAddress",
          streetAddress: "1 Test St",
          addressLocality: "Testville",
          addressRegion: "VIC",
          postalCode: "3000",
        },
      },
    ],
    ariaLabels,
  };
}

async function main() {
  // --- Domain normalize (pure, no browser) ---
  {
    const { property, images } = DomainAdapter.normalize(domainRaw);
    assert.equal(property.sourceSite, "domain");
    assert.equal(property.beds, 3, "domain beds");
    assert.equal(property.baths, 2, "domain baths");
    assert.equal(property.parking, 1, "domain parking");
    assert.equal(property.priceNumeric, 900000, "domain price parsed");
    assert.match(String(property.address), /Domain Rd/, "domain address");
    assert.equal(property.postcode, "2000", "domain postcode");
    assert.equal(
      property.nextInspection,
      new Date("2999-01-04T11:00:00+11:00").toISOString(),
      "domain picks the soonest upcoming inspection",
    );
    assert.equal(images.length, 2, "domain images harvested by host regex");
    assert.ok(
      images[0].sourceUrl.includes("domainstatic.com.au"),
      "domain image host",
    );
  }

  // --- REA: real fixture, full Definition of Done ---
  {
    const { property, images } = ReaAdapter.normalize(reaFixtureRaw);
    assert.equal(property.sourceSite, "rea");
    assert.equal(
      property.address,
      "46 Astoria Drive, Point Cook, VIC 3030",
      "rea fixture address",
    );
    assert.equal(property.suburb, "Point Cook", "rea fixture suburb");
    assert.equal(property.state, "VIC", "rea fixture state");
    assert.equal(property.postcode, "3030", "rea fixture postcode");
    assert.equal(
      property.priceDisplay,
      "$820,000 - $902,000",
      "rea fixture priceDisplay",
    );
    assert.equal(property.priceNumeric, 820000, "rea fixture priceNumeric");
    assert.equal(property.beds, 6, "rea fixture beds");
    assert.equal(property.baths, 3, "rea fixture baths");
    assert.equal(property.parking, 2, "rea fixture parking");
    assert.equal(property.propertyType, "House", "rea fixture propertyType");
    assert.equal(property.externalId, "152196328", "rea fixture externalId");
    assert.equal(
      property.nextInspection,
      new Date("2026-09-05T12:00:00+10:00").toISOString(),
      "rea fixture nextInspection",
    );
    assert.ok(
      property.description && property.description.length > 0,
      "rea fixture description non-empty",
    );
    assert.ok(
      !property.description!.includes("<br"),
      "rea fixture description has no <br/> markup",
    );
    assert.equal(
      property.agencyName,
      "Harcourts Settle",
      "rea fixture agencyName from Event.organizer.name",
    );
    assert.equal(images.length, 1, "rea fixture exactly one image");
    assert.equal(images[0].ordinal, 0, "rea fixture cover at ordinal 0");
    assert.ok(
      images[0].sourceUrl.includes("800x600") &&
        images[0].sourceUrl.includes(
          "7adb91e2241e229e7cab6676b0b7a0568592eaae40e0f04b412919938e0acfe9",
        ),
      "rea fixture cover is the 800x600 hero",
    );

    // Individually — a count of 1 alone would also pass if the filter had
    // dropped the right NUMBER of the wrong images.
    const excludedUrls = [
      "https://i2.au.reastatic.net/340x64/1b00d61af1d87e42019c606c158f86e8fd8389e9b5ae8e15a96ae6a1248be300/logo.jpg",
      "https://i2.au.reastatic.net/200x200-crop,gravity=north/e9e22b5e9c53b8952e6459071297fdc581edaaeb32351989907d97456d2d98f8/main.jpg",
      "https://argonaut.au.reastatic.net/resi-property/prod/listing-experience-web/placeholder-d012bfd7d088c7ee475b.svg",
      "https://argonaut.au.reastatic.net/resi-property/prod/listing-experience-web/DoraExplorer-fbce6a0e2b0f515e4425.svg",
      "https://i2.au.reastatic.net/310x175/a60d4a866a2be374c96cf41c25ed56bbd97f94c1778eb78a0e45eddaad7602ff/image.jpg",
      "https://i2.au.reastatic.net/310x175/c2301f2304d48334206948ffad872b44dea34ec147a43a93acebd0b597a490b8/image.jpg",
      "https://i2.au.reastatic.net/310x175/90a2e5551c787a602db971fc7ddb9a7e8feb64c281c321de065c01544765a9ae/image.jpg",
    ];
    for (const url of excludedUrls) {
      assert.ok(
        !images.some((img) => img.sourceUrl === url),
        `rea fixture excludes ${url}`,
      );
    }
  }

  // --- REA: composite aria-label parsing ---
  {
    // No land size, no "with study" interjection.
    const { property } = ReaAdapter.normalize(
      reaAriaPayload(["House  with 6 bedrooms  3 bathrooms 2 car spaces"]),
    );
    assert.equal(property.propertyType, "House", "aria basic propertyType");
    assert.equal(property.beds, 6, "aria basic beds");
    assert.equal(property.baths, 3, "aria basic baths");
    assert.equal(property.parking, 2, "aria basic parking");
    assert.equal(property.landSizeSqm, null, "aria basic has no land size");
  }
  {
    // Land size present, plus a "with study" interjection between beds and baths.
    const { property } = ReaAdapter.normalize(
      reaAriaPayload([
        "House with 701m² land size with 4 bedrooms with study 2 bathrooms 2 car spaces",
      ]),
    );
    assert.equal(property.propertyType, "House", "aria land+study propertyType");
    assert.equal(property.beds, 4, "aria land+study beds");
    assert.equal(property.baths, 2, "aria land+study baths");
    assert.equal(property.parking, 2, "aria land+study parking");
    assert.equal(property.landSizeSqm, 701, "aria land+study land size");
  }
  {
    // Land size present, double space before "bedrooms" (real-world whitespace quirk).
    const { property } = ReaAdapter.normalize(
      reaAriaPayload([
        "House with 305m² land size with 3 bedrooms  2 bathrooms 2 car spaces",
      ]),
    );
    assert.equal(property.propertyType, "House", "aria second land-size propertyType");
    assert.equal(property.beds, 3, "aria second land-size beds");
    assert.equal(property.baths, 2, "aria second land-size baths");
    assert.equal(property.parking, 2, "aria second land-size parking");
    assert.equal(property.landSizeSqm, 305, "aria second land-size value");
  }
  {
    // Singulars, and a LATER similar-listing-card aria-label of the same shape
    // must not override the first match.
    const { property } = ReaAdapter.normalize(
      reaAriaPayload([
        "House with 1 bedroom 1 bathroom 1 car space",
        "Townhouse with 5 bedrooms 4 bathrooms 3 car spaces",
      ]),
    );
    assert.equal(property.propertyType, "House", "aria singulars propertyType (first match wins)");
    assert.equal(property.beds, 1, "aria singulars beds (first match wins)");
    assert.equal(property.baths, 1, "aria singulars baths (first match wins)");
    assert.equal(property.parking, 1, "aria singulars parking (first match wins)");
  }

  // --- REA: multi-size dedupe collapses to the largest width ---
  {
    const hash = "abc123def456abc123def456abc123def456abc123def456abc123def456ab";
    const dedupeRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-dedupe-888888888",
      jsonLd: [
        {
          "@type": "Residence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "2 Dedupe St",
            addressLocality: "Dedupeville",
            addressRegion: "VIC",
            postalCode: "3000",
          },
        },
      ],
      imgUrls: [
        `https://i2.au.reastatic.net/800x600/${hash}/image.png`,
        `https://i2.au.reastatic.net/1896x1216-resize,extend,r=33,g=40,b=46/${hash}/image.png`,
        `https://i2.au.reastatic.net/3792x2432-resize,r=33,g=40,b=46/${hash}/image.png`,
      ],
    };
    const { images } = ReaAdapter.normalize(dedupeRaw);
    assert.equal(images.length, 1, "rea multi-size dedupe collapses to one image");
    assert.ok(
      images[0].sourceUrl.startsWith("https://i2.au.reastatic.net/3792x2432"),
      "rea multi-size dedupe keeps the largest width",
    );
  }

  // --- REA: no Event block at all (og:image is the ONLY source of hero order) ---
  {
    const coverHash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbe0";
    const otherHash = "cafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefe0";
    const coverUrl = `https://i2.au.reastatic.net/800x600/${coverHash}/image.png`;
    const otherUrl = `https://i2.au.reastatic.net/800x600/${otherHash}/image.png`;
    const noEventRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-noevent-777777777",
      jsonLd: [
        {
          "@type": "Residence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "3 NoEvent St",
            addressLocality: "NoEventville",
            addressRegion: "VIC",
            postalCode: "3000",
          },
        },
        // Deliberately no Event block — listings with no scheduled inspection
        // have none at all; og:image must still identify the cover.
      ],
      ogImage: coverUrl,
      // otherUrl appears FIRST in the DOM harvest — without og:image driving
      // the ordering, first-seen order would wrongly put it at ordinal 0.
      imgUrls: [otherUrl, coverUrl],
      ariaLabels: ["House with 2 bedrooms 1 bathroom 1 car space"],
      bodyText: "$400,000",
    };
    const { property, images } = ReaAdapter.normalize(noEventRaw);
    assert.equal(images.length, 2, "rea no-event-block keeps both gallery images");
    assert.equal(images[0].ordinal, 0, "rea no-event-block cover is ordinal 0");
    assert.equal(
      images[0].sourceUrl,
      coverUrl,
      "rea no-event-block cover is the og:image match, not merely the first-seen DOM image",
    );
    assert.equal(property.nextInspection, null, "rea no-event-block has no nextInspection");
    assert.equal(property.agencyName, null, "rea no-event-block has no agencyName");
  }

  // --- REA: nextInspection skips an already-run open home for a future one ---
  {
    const past = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const future = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
    const { property } = ReaAdapter.normalize(reaEventsPayload([past, future]));
    assert.equal(
      property.nextInspection,
      future,
      "rea nextInspection skips an already-run inspection for the upcoming one",
    );
  }
  {
    // Same-day boundary, parity with domain.ts: a time earlier today but still
    // within the 6-hour cutoff is kept (it's the soonest still-relevant time),
    // while one well past that window is dropped.
    const withinCutoff = new Date(Date.now() - 3 * 3600_000).toISOString();
    const wellPast = new Date(Date.now() - 10 * 3600_000).toISOString();
    const { property } = ReaAdapter.normalize(
      reaEventsPayload([wellPast, withinCutoff]),
    );
    assert.equal(
      property.nextInspection,
      withinCutoff,
      "rea nextInspection keeps a within-6h-window past slot visible, drops one well past it",
    );
  }

  // --- REA: price decoys ---
  {
    const priceRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-price-666666666",
      jsonLd: [
        {
          "@type": "Residence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "4 Price St",
            addressLocality: "Priceville",
            addressRegion: "VIC",
            postalCode: "3000",
          },
        },
      ],
      bodyText:
        "$500,000 - $550,000\nPrice guide details\nMonthly repayments\n$3,431\nCalculate",
    };
    const { property } = ReaAdapter.normalize(priceRaw);
    assert.equal(
      property.priceDisplay,
      "$500,000 - $550,000",
      "rea price resolves to the FIRST $-anchored run, not the later repayment figure",
    );
    assert.equal(property.priceNumeric, 500000, "rea price numeric from first run");
  }
  {
    const auctionRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-auction-666666667",
      jsonLd: [
        {
          "@type": "Residence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "4a Auction St",
            addressLocality: "Priceville",
            addressRegion: "VIC",
            postalCode: "3000",
          },
        },
      ],
      bodyText: "Auction Sat 10 Oct 11:00am\nAdded 2 hours ago",
    };
    const { property } = ReaAdapter.normalize(auctionRaw);
    assert.equal(
      property.priceDisplay,
      "Auction",
      "rea falls back to non-price display when no $ appears",
    );
    assert.equal(property.priceNumeric, null, "rea non-price display has no numeric price");
  }

  // --- REA: graceful degradation ---
  {
    // JSON-LD present, no DOM bag at all -> normalizes as "partial", not "ok".
    const jsonLdOnlyRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-partial-555555555",
      jsonLd: [
        {
          "@type": "Residence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "5 Partial St",
            addressLocality: "Partialville",
            addressRegion: "VIC",
            postalCode: "3000",
          },
        },
      ],
    };
    const { property } = ReaAdapter.normalize(jsonLdOnlyRaw);
    assert.equal(
      property.address,
      "5 Partial St, Partialville, VIC 3000",
      "rea partial row still gets address from JSON-LD",
    );
    assert.notEqual(
      property.status,
      "ok",
      "rea address-only row reports partial, not ok",
    );
  }
  {
    // Neither JSON-LD nor DOM bag -> throws.
    const emptyRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-empty-444444444",
      jsonLd: [],
    };
    assert.throws(
      () => ReaAdapter.normalize(emptyRaw),
      (err: unknown) => err instanceof ScrapeError,
      "rea throws ScrapeError with neither JSON-LD nor usable DOM bag",
    );
  }

  // --- REA: backward compatibility with an un-updated extension payload ---
  {
    const coverUrl =
      "https://i2.au.reastatic.net/800x600/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/image.jpg";
    const legacyRaw: RawPageData = {
      url: "https://www.realestate.com.au/property-house-vic-legacy-333333333",
      jsonLd: [
        {
          "@type": "Residence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "6 Legacy St",
            addressLocality: "Legacyville",
            addressRegion: "VIC",
            postalCode: "3000",
          },
        },
        {
          "@type": "Event",
          startDate: "2026-10-01T10:00:00+10:00",
          image: [coverUrl],
          organizer: { "@type": "Organization", name: "Legacy Realty" },
        },
      ],
      imgUrls: [coverUrl],
      // No ogDescription, bodyText, ariaLabels or ogImage — what an
      // un-updated extension in the wild sends.
    };
    const { property, images } = ReaAdapter.normalize(legacyRaw);
    assert.equal(
      property.address,
      "6 Legacy St, Legacyville, VIC 3000",
      "rea legacy payload still gets address",
    );
    assert.equal(
      property.agencyName,
      "Legacy Realty",
      "rea legacy payload still gets agencyName from Event.organizer",
    );
    assert.equal(
      images.length,
      1,
      "rea legacy payload still gets the Event.image[0] cover via fallback",
    );
    assert.equal(
      images[0].sourceUrl,
      coverUrl,
      "rea legacy payload cover falls back to Event.image[0] without og:image",
    );
    assert.equal(
      property.description,
      null,
      "rea legacy payload has no description without ogDescription",
    );
    assert.equal(
      property.beds,
      null,
      "rea legacy payload has no beds without ariaLabels",
    );
    assert.equal(
      property.priceDisplay,
      null,
      "rea legacy payload has no price without bodyText",
    );
  }

  // --- DOM img fallback via raw.imgUrls (no embedded gallery) ---
  {
    const { images } = DomainAdapter.normalize({
      url: "https://www.domain.com.au/x-123456",
      nextData: {},
      jsonLd: [{ "@type": "Residence", name: "X" }],
      imgUrls: [
        "https://rimh2.domainstatic.com.au/zzz/1.jpg",
        "https://example.com/not-a-listing.jpg",
      ],
    });
    assert.equal(images.length, 1, "only CDN-host imgs kept from DOM fallback");
  }

  // --- Image sources are UNIONED (embedded gallery + DOM carousel) ---
  {
    const { images } = DomainAdapter.normalize({
      url: "https://www.domain.com.au/y-234567",
      nextData: {
        props: {
          pageProps: {
            componentProps: {
              media: [
                { url: "https://rimh2.domainstatic.com.au/aaa/2000x1500/1.jpg" },
              ],
            },
          },
        },
      },
      jsonLd: [],
      // A carousel image that only appears in the DOM, not in nextData:
      imgUrls: ["https://rimh2.domainstatic.com.au/bbb/2000x1500/2.jpg"],
    });
    assert.equal(
      images.length,
      2,
      "embedded gallery + DOM carousel images are unioned",
    );
  }

  // --- Anti-bot wall detection (readRawFromPage, needs a browser) ---
  // Reuse the app's own resolver so this works on any OS with a Chrome/Edge
  // installed, not just the Linux path CHROMIUM defaults to.
  const { getBrowser } = await import("../src/scrape/browser");
  const browser: Browser = process.env.CHROMIUM_PATH
    ? await chromium.launch({
        executablePath: CHROMIUM,
        headless: true,
        args: ["--no-sandbox"],
      })
    : await getBrowser();
  const ctx = await browser.newContext();
  try {
    {
      const page = await ctx.newPage();
      await page.setContent(
        "<html><head><title>Are you a robot?</title></head><body>blocked</body></html>",
      );
      let threw: unknown;
      try {
        await readRawFromPage(page, "https://www.domain.com.au/x");
      } catch (e) {
        threw = e;
      }
      assert.ok(
        threw instanceof ScrapeError && threw.wall,
        "domain wall detected",
      );
      await page.close();
    }
    {
      const page = await ctx.newPage();
      await page.setContent(
        "<html><head><title>Pardon Our Interruption</title></head><body>verify you are human</body></html>",
      );
      let threw: unknown;
      try {
        await readRawFromPage(page, "https://www.realestate.com.au/x");
      } catch (e) {
        threw = e;
      }
      assert.ok(
        threw instanceof ScrapeError && threw.wall,
        "rea wall detected",
      );
      await page.close();
    }
    console.log("✓ adapters.test: all assertions passed");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("✗ adapters.test FAILED:", e);
  process.exit(1);
});
