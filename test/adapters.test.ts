/**
 * Offline unit tests for the REAL Domain/REA adapters. Uses page.setContent()
 * with site-shaped fixtures (no network — this sandbox blocks the live sites),
 * exercising the adapters' embedded-JSON parsing, image-host regexes, and
 * anti-bot wall detection.
 */
import assert from "node:assert";
import { chromium, type Browser } from "playwright-core";
import { DomainAdapter } from "../src/scrape/adapters/domain";
import { ReaAdapter } from "../src/scrape/adapters/rea";
import { ScrapeError } from "../src/scrape/adapters/base";

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

function domainHtml(): string {
  const nextData = {
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
        },
      },
    },
  };
  const ld = {
    "@type": "Residence",
    name: "5 Domain Rd, Suburbia NSW 2000",
    address: {
      addressLocality: "Suburbia",
      addressRegion: "NSW",
      postalCode: "2000",
    },
  };
  return `<!doctype html><html><head><title>5 Domain Rd</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head>
<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

function reaHtml(): string {
  const nextData = {
    props: {
      pageProps: {
        listing: {
          listingId: "146000111",
          displayPrice: "Offers over $1,100,000",
          bedrooms: 4,
          bathrooms: 3,
          parkingSpaces: 2,
          propertyType: "House",
          fullAddress: "9 Rea St, Metroville QLD 4000",
          suburb: "Metroville",
          state: "QLD",
          postcode: "4000",
          media: [
            { url: "https://i2.au.reastatic.net/800x600/x/a.jpg" },
            { url: "https://i2.au.reastatic.net/800x600/y/b.jpg" },
            { url: "https://i2.au.reastatic.net/800x600/z/c.jpg" },
          ],
        },
      },
    },
  };
  return `<!doctype html><html><head><title>9 Rea St</title></head>
<body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

async function main() {
  const browser: Browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext();
  try {
    // --- Domain adapter ---
    {
      const page = await ctx.newPage();
      await page.setContent(domainHtml());
      const { property, images } = await DomainAdapter.extract(
        page,
        "https://www.domain.com.au/5-domain-rd-suburbia-nsw-2000-2019555111",
      );
      assert.equal(property.sourceSite, "domain");
      assert.equal(property.beds, 3, "domain beds");
      assert.equal(property.baths, 2, "domain baths");
      assert.equal(property.parking, 1, "domain parking");
      assert.equal(property.priceNumeric, 900000, "domain price parsed");
      assert.match(String(property.address), /Domain Rd/, "domain address");
      assert.equal(property.postcode, "2000", "domain postcode");
      assert.equal(images.length, 2, "domain images harvested by host regex");
      assert.ok(
        images[0].sourceUrl.includes("domainstatic.com.au"),
        "domain image host",
      );
      await page.close();
    }

    // --- REA adapter ---
    {
      const page = await ctx.newPage();
      await page.setContent(reaHtml());
      const { property, images } = await ReaAdapter.extract(
        page,
        "https://www.realestate.com.au/property-house-qld-metroville-146000111",
      );
      assert.equal(property.sourceSite, "rea");
      assert.equal(property.beds, 4, "rea beds");
      assert.equal(property.baths, 3, "rea baths");
      assert.equal(property.parking, 2, "rea parking");
      assert.equal(property.priceNumeric, 1100000, "rea price parsed");
      assert.match(String(property.address), /Rea St/, "rea address");
      assert.equal(images.length, 3, "rea images harvested");
      await page.close();
    }

    // --- Anti-bot wall detection ---
    {
      const page = await ctx.newPage();
      await page.setContent(
        "<html><head><title>Are you a robot?</title></head><body>blocked</body></html>",
      );
      let threw: unknown;
      try {
        await DomainAdapter.extract(page, "https://www.domain.com.au/x");
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
        await ReaAdapter.extract(page, "https://www.realestate.com.au/x");
      } catch (e) {
        threw = e;
      }
      assert.ok(threw instanceof ScrapeError && threw.wall, "rea wall detected");
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
