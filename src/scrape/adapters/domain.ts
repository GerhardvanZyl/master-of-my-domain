import type { Page } from "playwright-core";
import type { Adapter, } from "./base";
import { ScrapeError, firstInt, parsePrice } from "./base";
import type { ExtractResult, NormalizedImage, NormalizedProperty } from "../types";
import {
  readNextData,
  readJsonLd,
  collectImageUrls,
  firstDeep,
} from "../extract";

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
  async extract(page: Page, url: string): Promise<ExtractResult> {
    // Detect bot/consent walls early.
    const title = (await page.title().catch(() => "")) || "";
    if (/access denied|are you a robot|verify you are human/i.test(title)) {
      throw new ScrapeError(`Blocked by anti-bot wall (title: "${title}")`, true);
    }

    const nextData = await readNextData(page);
    const jsonLd = await readJsonLd(page);

    if (!nextData && jsonLd.length === 0) {
      throw new ScrapeError(
        "No __NEXT_DATA__ or JSON-LD found — page shape may have changed or was blocked.",
      );
    }

    // --- Address / geo (prefer JSON-LD RealEstateListing/Residence) ---
    const ld = jsonLd.map(asRecord).find((o) => o !== null) as
      | Record<string, unknown>
      | undefined;
    const ldAddress = asRecord(ld?.address);
    const ldGeo = asRecord(ld?.geo);

    // --- Deep values from __NEXT_DATA__ ---
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
      (await page
        .$eval('meta[property="og:title"]', (el) =>
          el.getAttribute("content"),
        )
        .catch(() => null));

    const suburb = str(ldAddress?.addressLocality ?? firstDeep(root, ["suburb"]));
    const state = str(
      ldAddress?.addressRegion ?? firstDeep(root, ["state"]),
    );
    const postcode = str(
      ldAddress?.postalCode ?? firstDeep(root, ["postcode", "postCode"]),
    );
    const latitude = Number(ldGeo?.latitude ?? firstDeep(root, ["latitude"]));
    const longitude = Number(
      ldGeo?.longitude ?? firstDeep(root, ["longitude"]),
    );
    const externalId = str(firstDeep(root, ["listingId", "adId", "id"]));

    // --- Images: harvest from __NEXT_DATA__, then JSON-LD, then <img> DOM ---
    let urls = collectImageUrls(root, DOMAIN_IMG_HOST);
    if (urls.length === 0) urls = collectImageUrls(jsonLd, DOMAIN_IMG_HOST);
    if (urls.length === 0) {
      urls = await page
        .$$eval("img", (imgs) =>
          imgs
            .map((i) => (i as HTMLImageElement).src)
            .filter((s) => /domainstatic\.com\.au/i.test(s)),
        )
        .catch(() => [] as string[]);
      urls = [...new Set(urls)];
    }

    const images: NormalizedImage[] = urls.map((sourceUrl, ordinal) => ({
      sourceUrl,
      ordinal,
    }));

    const property: NormalizedProperty = {
      sourceSite: "domain",
      listingUrl: url,
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
