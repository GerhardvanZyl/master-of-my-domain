# Browser-Capture Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the paste-URL server-scrape path with a Chrome extension that captures Domain/REA listing data from the page you're already viewing and POSTs it to a new local `/api/ingest` endpoint.

**Architecture:** The extension is a dumb collector (reads embedded JSON + image srcs from the DOM/page globals) and POSTs a raw payload. All normalization stays server-side: the adapters are refactored from `extract(page)` to a pure `normalize(raw)` that both the extension and the existing Playwright CLI share. Images are still server-fetched from the CDN via the existing `syncImages`.

**Tech Stack:** Next.js App Router + TypeScript, better-sqlite3 (Drizzle), Playwright (CLI only, unchanged), Chrome Manifest V3 extension (vanilla JS, no build step).

## Global Constraints

- All property/image DB writes go through the existing helpers (`upsertProperty`, `syncImages`); never write `data/app.db` directly.
- Adapters must degrade gracefully (return `status: "partial"` / throw `ScrapeError`), never crash the pipeline.
- No new npm dependencies. The extension is vanilla JS with no build step.
- `normalize(raw)` must be pure and synchronous (no Playwright, no `await`) — it is shared with the browser extension.
- Keep the `npm run scrape` Playwright CLI working (minimal removal — do not delete `runScrape`, adapters, or `browser.ts`).
- The app runs at `http://localhost:3000`.
- `npm test` must stay green after every task that touches server code.

---

## File Structure

**Created:**
- `src/app/api/ingest/route.ts` — POST endpoint: normalize raw payload → upsert property + images → log to `scrape_jobs`.
- `test/ingest.test.ts` — offline test of the ingest route (temp DB, no network).
- `extension/manifest.json` — MV3 manifest.
- `extension/injected.js` — MAIN-world collector (reads globals + embedded JSON, postMessages payload).
- `extension/content.js` — isolated-world relay to the background worker.
- `extension/background.js` — service worker: POSTs to `/api/ingest`.

**Modified:**
- `src/scrape/types.ts` — add `RawPageData`.
- `src/scrape/adapters/base.ts` — `Adapter` interface: `extract(page)` → `normalize(raw)`.
- `src/scrape/extract.ts` — add `readRawFromPage(page, url)` (the only Playwright-coupled read; holds the anti-bot wall check).
- `src/scrape/adapters/domain.ts` — `extract` → pure `normalize`.
- `src/scrape/adapters/rea.ts` — `extract` → pure `normalize`.
- `src/scrape/runScrape.ts` — call `readRawFromPage` then `adapter.normalize`.
- `test/adapters.test.ts` — data tests call `normalize(raw)` directly; wall tests call `readRawFromPage`.
- `test/pipeline.test.ts` — `LocalAdapter.extract` → `LocalAdapter.normalize`.
- `src/app/page.tsx` — drop `AddLinksForm` + `JobStatus`.
- `package.json` — add `test/ingest.test.ts` to the `test` script.

**Deleted:**
- `src/components/AddLinksForm.tsx`, `src/components/JobStatus.tsx`, `src/app/api/scrape/route.ts`, `src/app/api/jobs/route.ts`, `src/scrape/queue.ts`.

---

## Task 1: Refactor adapters to a pure `normalize(raw)`

**Files:**
- Modify: `src/scrape/types.ts`
- Modify: `src/scrape/adapters/base.ts`
- Modify: `src/scrape/extract.ts`
- Modify: `src/scrape/adapters/domain.ts`
- Modify: `src/scrape/adapters/rea.ts`
- Modify: `src/scrape/runScrape.ts`
- Test: `test/adapters.test.ts`, `test/pipeline.test.ts`

**Interfaces:**
- Produces: `RawPageData` (`{ url: string; nextData?: unknown; jsonLd?: unknown[]; globals?: unknown; imgUrls?: string[]; title?: string; ogTitle?: string }`); `Adapter.normalize(raw: RawPageData): ExtractResult` (may throw `ScrapeError`); `readRawFromPage(page: Page, url: string): Promise<RawPageData>` (throws `ScrapeError(wall=true)` on anti-bot pages).
- Consumes: existing `collectImageUrls`, `firstDeep`, `readNextData`, `readJsonLd` (unchanged); `ExtractResult`, `NormalizedImage`, `NormalizedProperty`.

- [ ] **Step 1: Add `RawPageData` to `src/scrape/types.ts`**

Append to the file:

```ts
/** Everything normalize() needs, gathered either from a Playwright page
 *  (CLI, via readRawFromPage) or from the browser extension (in-page DOM). */
export interface RawPageData {
  url: string;
  nextData?: unknown;
  jsonLd?: unknown[];
  globals?: unknown;
  imgUrls?: string[];
  title?: string;
  ogTitle?: string;
}
```

- [ ] **Step 2: Change the `Adapter` interface in `src/scrape/adapters/base.ts`**

Replace the `import type { Page } ...` line and the `Adapter` interface. New top of file:

```ts
import type { ExtractResult, RawPageData } from "../types";

export class ScrapeError extends Error {
  constructor(
    message: string,
    /** true when the page looks like a bot/consent/CAPTCHA wall. */
    readonly wall = false,
  ) {
    super(message);
    this.name = "ScrapeError";
  }
}

export interface Adapter {
  readonly site: "domain" | "rea";
  matches(hostname: string): boolean;
  /** Pure, synchronous normalization from a raw payload. May throw ScrapeError.
   *  Shared by the CLI (via readRawFromPage) and the browser-extension ingest. */
  normalize(raw: RawPageData): ExtractResult;
}
```

Leave `firstInt` and `parsePrice` below, unchanged.

- [ ] **Step 3: Add `readRawFromPage` to `src/scrape/extract.ts`**

Add imports at the top (after the existing `import type { Page }`):

```ts
import type { RawPageData } from "./types";
import { ScrapeError } from "./adapters/base";
```

Append at the end of the file:

```ts
const WALL_RE =
  /access denied|are you a robot|verify you are (a )?human|unusual traffic|pardon our interruption/i;

/**
 * The ONLY Playwright-coupled extraction step. Gathers embedded JSON, window
 * globals, image srcs and titles from a live page, and throws ScrapeError
 * (wall=true) on anti-bot/consent interstitials. normalize() stays pure and is
 * shared with the browser-extension ingest path.
 */
export async function readRawFromPage(
  page: Page,
  url: string,
): Promise<RawPageData> {
  const title = (await page.title().catch(() => "")) || "";
  const bodyText = await page
    .$eval("body", (el) => (el as HTMLElement).innerText.slice(0, 400))
    .catch(() => "");
  if (WALL_RE.test(`${title}\n${bodyText}`)) {
    throw new ScrapeError(
      `Blocked by anti-bot/consent wall (title: "${title}")`,
      true,
    );
  }
  const nextData = await readNextData(page);
  const jsonLd = await readJsonLd(page);
  const globals = await page
    .evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return (w.__INITIAL_STATE__ ?? w.ArgonautExchange ?? w.REA) ?? null;
    })
    .catch(() => null);
  const imgUrls = await page
    .$$eval("img", (imgs) => imgs.map((i) => (i as HTMLImageElement).src))
    .catch(() => [] as string[]);
  const ogTitle = await page
    .$eval('meta[property="og:title"]', (el) => el.getAttribute("content"))
    .catch(() => null);
  return {
    url,
    nextData: nextData ?? undefined,
    jsonLd,
    globals: globals ?? undefined,
    imgUrls: [...new Set(imgUrls)],
    title,
    ogTitle: ogTitle ?? undefined,
  };
}
```

- [ ] **Step 4: Convert `src/scrape/adapters/domain.ts` to `normalize`**

Replace the whole file with:

```ts
import type { Adapter } from "./base";
import { ScrapeError, firstInt, parsePrice } from "./base";
import type {
  ExtractResult,
  NormalizedImage,
  NormalizedProperty,
  RawPageData,
} from "../types";
import { collectImageUrls, firstDeep } from "../extract";

const DOMAIN_IMG_HOST = /(domainstatic\.com\.au|bucket-api\.domain\.com\.au)/i;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

export const DomainAdapter: Adapter = {
  site: "domain",
  matches(hostname) {
    return /(^|\.)domain\.com\.au$/i.test(hostname);
  },
  normalize(raw: RawPageData): ExtractResult {
    const nextData = raw.nextData ?? null;
    const jsonLd = raw.jsonLd ?? [];
    if (!nextData && jsonLd.length === 0) {
      throw new ScrapeError(
        "No __NEXT_DATA__ or JSON-LD found — page shape may have changed or was blocked.",
      );
    }

    const ld = jsonLd.map(asRecord).find((o) => o !== null) as
      | Record<string, unknown>
      | undefined;
    const ldAddress = asRecord(ld?.address);
    const ldGeo = asRecord(ld?.geo);

    const root = nextData ?? {};
    const beds = firstInt(firstDeep(root, ["bedrooms", "beds"]));
    const baths = firstInt(firstDeep(root, ["bathrooms", "baths"]));
    const parking = firstInt(
      firstDeep(root, ["carspaces", "parking", "carSpaces"]),
    );
    const priceDisplay =
      str(firstDeep(root, ["displayPrice", "priceDisplay", "price"])) ??
      str(ld?.["offers"] && asRecord(ld?.["offers"])?.["price"]);
    const landSize = firstInt(firstDeep(root, ["landAreaSqm", "landSize"]));
    const propertyType = str(
      firstDeep(root, ["propertyType", "propertyTypeFormatted"]),
    );
    const agentName = str(firstDeep(root, ["agentName", "contactName"]));
    const agencyName = str(firstDeep(root, ["agencyName", "brandName"]));
    const description =
      str(firstDeep(root, ["description", "propertyDescription"])) ??
      str(ld?.description);

    const address =
      str(ld?.name) ??
      str(firstDeep(root, ["displayAddress", "fullAddress", "address"])) ??
      str(raw.ogTitle);

    const suburb = str(ldAddress?.addressLocality ?? firstDeep(root, ["suburb"]));
    const state = str(ldAddress?.addressRegion ?? firstDeep(root, ["state"]));
    const postcode = str(
      ldAddress?.postalCode ?? firstDeep(root, ["postcode", "postCode"]),
    );
    const latitude = Number(ldGeo?.latitude ?? firstDeep(root, ["latitude"]));
    const longitude = Number(
      ldGeo?.longitude ?? firstDeep(root, ["longitude"]),
    );
    const externalId = str(firstDeep(root, ["listingId", "adId", "id"]));

    let urls = collectImageUrls(root, DOMAIN_IMG_HOST);
    if (urls.length === 0) urls = collectImageUrls(jsonLd, DOMAIN_IMG_HOST);
    if (urls.length === 0) {
      urls = [
        ...new Set((raw.imgUrls ?? []).filter((s) => DOMAIN_IMG_HOST.test(s))),
      ];
    }

    const images: NormalizedImage[] = urls.map((sourceUrl, ordinal) => ({
      sourceUrl,
      ordinal,
    }));

    const property: NormalizedProperty = {
      sourceSite: "domain",
      listingUrl: raw.url,
      externalId,
      address,
      suburb,
      state,
      postcode,
      priceDisplay,
      priceNumeric: parsePrice(priceDisplay),
      beds,
      baths,
      parking,
      landSizeSqm: landSize,
      propertyType,
      agentName,
      agencyName,
      description,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      raw: {
        address,
        priceDisplay,
        beds,
        baths,
        parking,
        landSize,
        propertyType,
        imageCount: images.length,
      },
      status: address || priceDisplay || images.length > 0 ? "ok" : "partial",
    };

    return { property, images };
  },
};
```

- [ ] **Step 5: Convert `src/scrape/adapters/rea.ts` to `normalize`**

Replace the whole file with:

```ts
import type { Adapter } from "./base";
import { ScrapeError, firstInt, parsePrice } from "./base";
import type {
  ExtractResult,
  NormalizedImage,
  NormalizedProperty,
  RawPageData,
} from "../types";
import { collectImageUrls, firstDeep } from "../extract";

const REA_IMG_HOST = /reastatic\.net/i;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

export const ReaAdapter: Adapter = {
  site: "rea",
  matches(hostname) {
    return /(^|\.)realestate\.com\.au$/i.test(hostname);
  },
  normalize(raw: RawPageData): ExtractResult {
    const jsonLd = raw.jsonLd ?? [];
    const root = raw.nextData ?? raw.globals ?? {};
    if (!raw.nextData && !raw.globals && jsonLd.length === 0) {
      throw new ScrapeError(
        "No embedded JSON found for realestate.com.au — likely blocked or shape changed.",
      );
    }

    const ld = jsonLd.map(asRecord).find((o) => o !== null) as
      | Record<string, unknown>
      | undefined;
    const ldAddress = asRecord(ld?.address);
    const ldGeo = asRecord(ld?.geo);

    const beds = firstInt(firstDeep(root, ["bedrooms", "beds"]));
    const baths = firstInt(firstDeep(root, ["bathrooms", "baths"]));
    const parking = firstInt(
      firstDeep(root, ["parkingSpaces", "carspaces", "parking"]),
    );
    const priceDisplay = str(
      firstDeep(root, ["displayPrice", "priceText", "price"]),
    );
    const landSize = firstInt(firstDeep(root, ["landSize", "landAreaSqm"]));
    const propertyType = str(firstDeep(root, ["propertyType"]));
    const agentName = str(firstDeep(root, ["agentName", "contactName"]));
    const agencyName = str(firstDeep(root, ["agencyName", "brandName"]));
    const description =
      str(firstDeep(root, ["description"])) ?? str(ld?.description);
    const address =
      str(ld?.name) ??
      str(firstDeep(root, ["fullAddress", "displayAddress", "address"])) ??
      str(raw.ogTitle);
    const suburb = str(ldAddress?.addressLocality ?? firstDeep(root, ["suburb"]));
    const state = str(ldAddress?.addressRegion ?? firstDeep(root, ["state"]));
    const postcode = str(ldAddress?.postalCode ?? firstDeep(root, ["postcode"]));
    const latitude = Number(ldGeo?.latitude ?? firstDeep(root, ["latitude"]));
    const longitude = Number(
      ldGeo?.longitude ?? firstDeep(root, ["longitude"]),
    );
    const externalId = str(firstDeep(root, ["listingId", "id"]));

    let urls = collectImageUrls(root, REA_IMG_HOST);
    if (urls.length === 0) urls = collectImageUrls(jsonLd, REA_IMG_HOST);
    if (urls.length === 0) {
      urls = [
        ...new Set((raw.imgUrls ?? []).filter((s) => REA_IMG_HOST.test(s))),
      ];
    }

    const images: NormalizedImage[] = urls.map((sourceUrl, ordinal) => ({
      sourceUrl,
      ordinal,
    }));

    const property: NormalizedProperty = {
      sourceSite: "rea",
      listingUrl: raw.url,
      externalId,
      address,
      suburb,
      state,
      postcode,
      priceDisplay,
      priceNumeric: parsePrice(priceDisplay),
      beds,
      baths,
      parking,
      landSizeSqm: landSize,
      propertyType,
      agentName,
      agencyName,
      description,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      raw: {
        address,
        priceDisplay,
        beds,
        baths,
        parking,
        imageCount: images.length,
      },
      status: address || priceDisplay || images.length > 0 ? "ok" : "partial",
    };

    return { property, images };
  },
};
```

- [ ] **Step 6: Update `src/scrape/runScrape.ts` to use `readRawFromPage` + `normalize`**

Add `readRawFromPage` to the extract import and replace the extract call. Change the import block near the top:

```ts
import { newContext } from "./browser";
import { pickAdapter, ScrapeError } from "./adapters";
import type { Adapter } from "./adapters/base";
import { readRawFromPage } from "./extract";
import { upsertProperty } from "./persist";
import { syncImages, type ImageSyncResult } from "./images";
import type { NormalizedProperty } from "./types";
```

Replace this line:

```ts
    const { property, images } = await adapter.extract(page, url);
```

with:

```ts
    const raw = await readRawFromPage(page, url);
    const { property, images } = adapter.normalize(raw);
```

- [ ] **Step 7: Update `test/pipeline.test.ts` `LocalAdapter`**

Change the dynamic import line that pulls `readNextData` — it is no longer used by the test adapter (runScrape now reads the page itself):

```ts
  const { collectImageUrls, firstDeep } = await import(
    "../src/scrape/extract"
  );
```

Replace the `LocalAdapter` object's `extract` method with a `normalize`:

```ts
  const LocalAdapter = {
    site: "domain" as const,
    matches: (h: string) => LOCAL_HOST.test(h),
    normalize(raw: import("../src/scrape/types").RawPageData) {
      const root = raw.nextData ?? {};
      const urls = collectImageUrls(root, LOCAL_HOST);
      return {
        property: {
          sourceSite: "domain" as const,
          listingUrl: raw.url,
          address: String(firstDeep(root, ["displayAddress"]) ?? ""),
          suburb: String(firstDeep(root, ["suburb"]) ?? ""),
          state: String(firstDeep(root, ["state"]) ?? ""),
          postcode: String(firstDeep(root, ["postcode"]) ?? ""),
          priceDisplay: String(firstDeep(root, ["displayPrice"]) ?? ""),
          priceNumeric: parsePrice(firstDeep(root, ["displayPrice"])),
          beds: firstInt(firstDeep(root, ["bedrooms"])),
          baths: firstInt(firstDeep(root, ["bathrooms"])),
          parking: firstInt(firstDeep(root, ["carspaces"])),
          landSizeSqm: firstInt(firstDeep(root, ["landAreaSqm"])),
          propertyType: String(firstDeep(root, ["propertyType"]) ?? ""),
          status: "ok" as const,
        },
        images: urls.map((sourceUrl, ordinal) => ({ sourceUrl, ordinal })),
      };
    },
  };
```

- [ ] **Step 8: Rewrite `test/adapters.test.ts` to the new interface**

Replace the whole file with:

```ts
/**
 * Offline unit tests for the REAL Domain/REA adapters. The data path is now a
 * pure normalize(raw) — tested with raw fixtures, no browser. The anti-bot wall
 * check lives in readRawFromPage, tested with page.setContent().
 */
import assert from "node:assert";
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

const reaRaw: RawPageData = {
  url: "https://www.realestate.com.au/property-house-qld-metroville-146000111",
  nextData: {
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
  },
  jsonLd: [],
};

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
    assert.equal(images.length, 2, "domain images harvested by host regex");
    assert.ok(
      images[0].sourceUrl.includes("domainstatic.com.au"),
      "domain image host",
    );
  }

  // --- REA normalize (pure, no browser) ---
  {
    const { property, images } = ReaAdapter.normalize(reaRaw);
    assert.equal(property.sourceSite, "rea");
    assert.equal(property.beds, 4, "rea beds");
    assert.equal(property.baths, 3, "rea baths");
    assert.equal(property.parking, 2, "rea parking");
    assert.equal(property.priceNumeric, 1100000, "rea price parsed");
    assert.match(String(property.address), /Rea St/, "rea address");
    assert.equal(images.length, 3, "rea images harvested");
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

  // --- Anti-bot wall detection (readRawFromPage, needs a browser) ---
  const browser: Browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox"],
  });
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
```

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: all four test files print `✓ ... all assertions passed` (units, adapters, pipeline; ingest is added in Task 2). No TypeScript errors about `adapter.extract` or missing `normalize`.

- [ ] **Step 10: Commit**

```bash
git add src/scrape test/adapters.test.ts test/pipeline.test.ts
git commit -m "refactor: adapters expose pure normalize(raw); Playwright reads move to readRawFromPage"
```

---

## Task 2: `/api/ingest` endpoint + ingest log

**Files:**
- Create: `src/app/api/ingest/route.ts`
- Create: `test/ingest.test.ts`
- Modify: `package.json` (add ingest test to the `test` script)

**Interfaces:**
- Consumes: `pickAdapter`, `ScrapeError` from `@/scrape/adapters`; `Adapter.normalize`; `upsertProperty` from `@/scrape/persist`; `syncImages` from `@/scrape/images`; `db`, `scrapeJobs` from `@/db`; `newId` from `@/lib/id`.
- Produces: `POST /api/ingest` accepting `RawPageData` JSON, returning `{ ok: true, propertyId, images }` or `{ ok: false, error }`.

- [ ] **Step 1: Write the failing test `test/ingest.test.ts`**

```ts
/**
 * Offline test of the ingest route: raw payload -> normalize -> upsert property
 * -> log scrape_jobs. No network (a Domain fixture with no CDN images, so
 * syncImages is a no-op). Temp DB, set BEFORE importing app modules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ingest-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { POST } = await import("../src/app/api/ingest/route");
  migrate();

  const raw = {
    url: "https://www.domain.com.au/12-test-st-testville-nsw-2000-2019000111",
    nextData: {
      props: {
        pageProps: {
          componentProps: {
            listingSummary: {
              listingId: "2019000111",
              displayPrice: "$1,250,000",
              bedrooms: 4,
              bathrooms: 2,
              carspaces: 2,
              displayAddress: "12 Test St, Testville NSW 2000",
              suburb: "Testville",
              state: "NSW",
              postcode: "2000",
            },
          },
        },
      },
    },
    jsonLd: [],
    imgUrls: [],
  };

  const res = await POST(
    new Request("http://localhost:3000/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    }),
  );
  const data = (await res.json()) as { ok: boolean; propertyId?: string };
  assert.equal(res.status, 200, "ingest returns 200");
  assert.ok(data.ok, "ingest ok");

  const prop = sqlite
    .prepare("SELECT * FROM properties WHERE listing_url = ?")
    .get(raw.url) as Record<string, unknown>;
  assert.equal(prop.beds, 4, "beds persisted");
  assert.equal(prop.price_numeric, 1250000, "price persisted");
  assert.equal(prop.id, data.propertyId, "returned propertyId matches row");

  const job = sqlite
    .prepare("SELECT * FROM scrape_jobs WHERE url = ?")
    .get(raw.url) as Record<string, unknown>;
  assert.ok(job, "ingest logged a scrape_jobs row");
  assert.equal(job.status, "done", "job done");
  assert.equal(job.property_id, data.propertyId, "job linked to property");

  // Re-ingest the same URL: idempotent (1 property, still 1 job row).
  await POST(
    new Request("http://localhost:3000/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    }),
  );
  const propCount = (
    sqlite.prepare("SELECT COUNT(*) c FROM properties").get() as { c: number }
  ).c;
  const jobCount = (
    sqlite
      .prepare("SELECT COUNT(*) c FROM scrape_jobs WHERE url = ?")
      .get(raw.url) as { c: number }
  ).c;
  assert.equal(propCount, 1, "still 1 property after re-ingest");
  assert.equal(jobCount, 1, "still 1 job row after re-ingest");

  // Unsupported host -> 400.
  const bad = await POST(
    new Request("http://localhost:3000/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/foo" }),
    }),
  );
  assert.equal(bad.status, 400, "unsupported host -> 400");

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ ingest.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ ingest.test FAILED:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/ingest.test.ts`
Expected: FAIL — cannot find module `../src/app/api/ingest/route`.

- [ ] **Step 3: Create `src/app/api/ingest/route.ts`**

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { pickAdapter, ScrapeError } from "@/scrape/adapters";
import { upsertProperty } from "@/scrape/persist";
import { syncImages } from "@/scrape/images";
import { db } from "@/db/client";
import { scrapeJobs } from "@/db/schema";
import { newId } from "@/lib/id";
import type { RawPageData } from "@/scrape/types";

export const runtime = "nodejs";

/** Upsert one ingest-log row per listing URL (this IS the search history). */
function logIngest(url: string, propertyId: string | null, error: string | null) {
  const now = new Date().toISOString();
  const status = error ? "error" : "done";
  const existing = db
    .select({ id: scrapeJobs.id })
    .from(scrapeJobs)
    .where(eq(scrapeJobs.url, url))
    .get();
  if (existing) {
    db.update(scrapeJobs)
      .set({ status, propertyId, error, updatedAt: now })
      .where(eq(scrapeJobs.id, existing.id))
      .run();
  } else {
    db.insert(scrapeJobs)
      .values({ id: newId("job"), url, status, propertyId, error, createdAt: now, updatedAt: now })
      .run();
  }
}

export async function POST(req: Request) {
  const raw = (await req.json().catch(() => null)) as RawPageData | null;
  if (!raw || typeof raw.url !== "string") {
    return NextResponse.json({ ok: false, error: "missing url" }, { status: 400 });
  }
  const adapter = pickAdapter(raw.url);
  if (!adapter) {
    return NextResponse.json(
      { ok: false, error: "unsupported site (domain.com.au / realestate.com.au only)" },
      { status: 400 },
    );
  }
  try {
    const { property, images } = adapter.normalize(raw);
    const propertyId = upsertProperty(property, { status: property.status ?? "ok" });
    const imgResult = await syncImages(propertyId, images, raw.url);
    logIngest(raw.url, propertyId, null);
    return NextResponse.json({ ok: true, propertyId, images: imgResult });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logIngest(raw.url, null, message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: err instanceof ScrapeError ? 422 : 500 },
    );
  }
}
```

- [ ] **Step 4: Add the test to the `test` script in `package.json`**

Change the `test` script value to:

```
"test": "tsx test/units.test.ts && tsx test/adapters.test.ts && tsx test/pipeline.test.ts && tsx test/ingest.test.ts",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx test/ingest.test.ts`
Expected: PASS — `✓ ingest.test: all assertions passed`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all four files pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/ingest/route.ts test/ingest.test.ts package.json
git commit -m "feat: /api/ingest endpoint for browser-captured listings"
```

---

## Task 3: Remove the paste-URL scrape path

**Files:**
- Delete: `src/components/AddLinksForm.tsx`, `src/components/JobStatus.tsx`, `src/app/api/scrape/route.ts`, `src/app/api/jobs/route.ts`, `src/scrape/queue.ts`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `PropertyGrid`, `SearchHistory`, `listProperties`, `listSearchHistory` (all unchanged).

- [ ] **Step 1: Confirm `queue.ts` has no remaining callers**

Run: `grep -rn "enqueueScrape\|scrape/queue\|api/jobs\|api/scrape\|AddLinksForm\|JobStatus" src`
Expected: matches only inside the files being deleted and the `page.tsx` import lines edited in Step 3. If anything else references them, stop and reconcile.

- [ ] **Step 2: Delete the paste-path files**

```bash
git rm src/components/AddLinksForm.tsx src/components/JobStatus.tsx src/app/api/scrape/route.ts src/app/api/jobs/route.ts src/scrape/queue.ts
```

- [ ] **Step 3: Update `src/app/page.tsx`**

Replace the whole file with:

```tsx
import PropertyGrid from "@/components/PropertyGrid";
import SearchHistory from "@/components/SearchHistory";
import { listProperties } from "@/db/queries/properties";
import { listSearchHistory } from "@/db/queries/jobs";

export const dynamic = "force-dynamic";

export default function Home() {
  const properties = listProperties();
  const history = listSearchHistory();
  return (
    <div className="space-y-6">
      <SearchHistory jobs={history} />
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">
          Tracked properties ({properties.length})
        </h1>
      </div>
      <PropertyGrid properties={properties} />
    </div>
  );
}
```

- [ ] **Step 4: Typecheck for dangling imports**

Run: `npx tsc --noEmit`
Expected: no errors (no lingering references to the deleted modules).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all four files pass (the CLI/adapters/ingest paths are untouched by the deletions).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove paste-URL scrape path (form, /api/scrape, /api/jobs, queue)"
```

---

## Task 4: Chrome extension (MV3 collector)

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/injected.js`
- Create: `extension/content.js`
- Create: `extension/background.js`

**Interfaces:**
- Produces: POSTs `RawPageData` JSON to `http://localhost:3000/api/ingest` (the Task 2 endpoint).

- [ ] **Step 1: Create `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Master of my Domain — Capture",
  "version": "1.0.0",
  "description": "Captures Domain/REA listing data from the page you're viewing and sends it to the local Property Compare app.",
  "host_permissions": ["http://localhost:3000/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["*://www.domain.com.au/*", "*://www.realestate.com.au/*"],
      "js": ["injected.js"],
      "world": "MAIN",
      "run_at": "document_idle"
    },
    {
      "matches": ["*://www.domain.com.au/*", "*://www.realestate.com.au/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 2: Create `extension/injected.js`**

```js
// Runs in the PAGE context (world: MAIN) so it can read the window globals that
// realestate.com.au stashes listing state on. Extracts embedded JSON + image
// srcs and hands them to the isolated content script via postMessage.
// Auto-fires on listing-detail pages, re-firing on SPA navigation (Domain is a
// Next.js SPA that swaps listings without a full reload).
(function () {
  const LISTING_RE = {
    "www.domain.com.au": /-\d{6,}\/?$/,
    "www.realestate.com.au": /\/property-/,
  };

  function isListing() {
    const re = LISTING_RE[location.hostname];
    return re ? re.test(location.pathname) : false;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function collect() {
    const nextEl = document.getElementById("__NEXT_DATA__");
    const nextData = nextEl ? parseJson(nextEl.textContent || "") : null;
    const jsonLd = [];
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((s) => {
        const v = parseJson(s.textContent || "");
        if (Array.isArray(v)) jsonLd.push(...v);
        else if (v) jsonLd.push(v);
      });
    const globals =
      window.__INITIAL_STATE__ || window.ArgonautExchange || window.REA || null;
    const imgUrls = [...new Set([...document.images].map((i) => i.src))];
    const og = document.querySelector('meta[property="og:title"]');
    return {
      url: location.href,
      nextData,
      jsonLd,
      globals,
      imgUrls,
      title: document.title,
      ogTitle: og ? og.getAttribute("content") : undefined,
    };
  }

  let lastUrl = null;
  function maybeSend() {
    if (!isListing() || location.href === lastUrl) return;
    lastUrl = location.href;
    // Let SPA content settle before reading embedded JSON.
    setTimeout(() => {
      const payload = collect();
      let json;
      try {
        json = JSON.stringify(payload);
      } catch {
        // Some site globals are circular/non-serializable — drop them.
        payload.globals = null;
        try {
          json = JSON.stringify(payload);
        } catch {
          return;
        }
      }
      window.postMessage({ source: "momd-collect", json }, "*");
    }, 800);
  }

  maybeSend();
  // ponytail: 1s href poll covers SPA nav on both sites; swap for a History API
  // hook only if it feels laggy.
  setInterval(maybeSend, 1000);
})();
```

- [ ] **Step 3: Create `extension/content.js`**

```js
// Isolated-world relay: receives the collected payload from injected.js (MAIN
// world) and forwards it to the background worker, which does the cross-origin
// POST to the local app.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "momd-collect" || typeof d.json !== "string") return;
  chrome.runtime.sendMessage({ type: "ingest", json: d.json });
});
```

- [ ] **Step 4: Create `extension/background.js`**

```js
// Service worker: the only extension context allowed to POST cross-origin to
// http://localhost:3000 (granted via host_permissions — no CORS/mixed-content
// concerns). Forwards the captured payload to the app's ingest endpoint.
const INGEST_URL = "http://localhost:3000/api/ingest";

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ingest" || typeof msg.json !== "string") return;
  fetch(INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: msg.json,
  })
    .then((r) => r.json())
    .then((d) => console.log("[momd] ingested", d))
    .catch((e) => console.warn("[momd] ingest failed", e));
});
```

- [ ] **Step 5: Manual verification**

1. Start the app: `npm run dev` (serves `http://localhost:3000`).
2. In Chrome: `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → select the `extension/` folder.
3. Open a real Domain listing (e.g. any `https://www.domain.com.au/<address>-<id>` detail page) while logged in.
4. Open the extension's service-worker console: `chrome://extensions` → the extension → **service worker** → **Inspect**. Expected: a `[momd] ingested { ok: true, propertyId: "prop_…", images: {…} }` log within ~2s.
5. Reload `http://localhost:3000` → the property appears in "Tracked properties" with its photos; it also shows in the "Search history" list.
6. Repeat with a real realestate.com.au listing (`/property-…`). Confirm a second property is captured.
7. Open a Domain **search results** page (not a listing). Expected: no ingest log line (the URL heuristic skips it).

- [ ] **Step 6: Commit**

```bash
git add extension
git commit -m "feat: Chrome extension captures Domain/REA listings to /api/ingest"
```

---

## Self-Review

**Spec coverage:**
- Auto-save on view → Task 4 `injected.js` (`maybeSend` on load + 1s poll). ✓
- Idempotent by `listingUrl` → Task 2 test re-ingest asserts 1 property / 1 job. ✓
- Dumb collector / server normalizes → Tasks 1 (`normalize`) + 4 (extension sends raw). ✓
- `RawPageData` type → Task 1 Step 1. ✓
- `readRawFromPage` holds the wall check; `normalize` pure → Task 1 Steps 3–5. ✓
- CLI keeps working → Task 1 Step 6 (`runScrape`) + pipeline test green (Step 7/9). ✓
- `/api/ingest` → upsert + syncImages + scrape_jobs log → Task 2. ✓
- Server-fetched images from CDN → Task 2 reuses `syncImages` unchanged. ✓
- Minimal removal (paste form, /api/scrape, /api/jobs, queue; keep CLI) → Task 3. ✓
- Extension = 4 MV3 files, MAIN-world for globals, background for POST → Task 4. ✓
- Tests updated to new interface, `npm test` green → Task 1 Steps 8–9, Task 2. ✓
- Extension manual verification only → Task 4 Step 5. ✓

**Placeholder scan:** none — every code step contains full content.

**Type consistency:** `normalize(raw: RawPageData): ExtractResult` used identically in base.ts, domain.ts, rea.ts, runScrape.ts, route.ts, and both tests. `RawPageData` fields (`url`, `nextData`, `jsonLd`, `globals`, `imgUrls`, `title`, `ogTitle`) match between the type def, `readRawFromPage`, the extension payload, and the route. `logIngest(url, propertyId, error)` signature consistent within route.ts.
