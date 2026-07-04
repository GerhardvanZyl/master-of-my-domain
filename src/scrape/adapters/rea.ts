import type { Page } from "playwright-core";
import type { Adapter } from "./base";
import { ScrapeError, firstInt, parsePrice } from "./base";
import type { ExtractResult, NormalizedImage, NormalizedProperty } from "../types";
import {
  readNextData,
  readJsonLd,
  collectImageUrls,
  firstDeep,
} from "../extract";

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
  async extract(page: Page, url: string): Promise<ExtractResult> {
    const title = (await page.title().catch(() => "")) || "";
    const bodyText = await page
      .$eval("body", (el) => el.innerText.slice(0, 400))
      .catch(() => "");
    if (
      /access denied|are you a robot|verify you are (a )?human|unusual traffic|pardon our interruption/i.test(
        `${title}\n${bodyText}`,
      )
    ) {
      throw new ScrapeError(
        `Blocked by anti-bot/consent wall (title: "${title}")`,
        true,
      );
    }

    const nextData = await readNextData(page);
    // REA sometimes exposes state on a window global rather than __NEXT_DATA__.
    const globalState = await page
      .evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return (w.__INITIAL_STATE__ ?? w.ArgonautExchange ?? w.REA) ?? null;
      })
      .catch(() => null);
    const jsonLd = await readJsonLd(page);

    const root = nextData ?? globalState ?? {};
    if (!nextData && !globalState && jsonLd.length === 0) {
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
      str(firstDeep(root, ["fullAddress", "displayAddress", "address"]));
    const suburb = str(ldAddress?.addressLocality ?? firstDeep(root, ["suburb"]));
    const state = str(ldAddress?.addressRegion ?? firstDeep(root, ["state"]));
    const postcode = str(
      ldAddress?.postalCode ?? firstDeep(root, ["postcode"]),
    );
    const latitude = Number(ldGeo?.latitude ?? firstDeep(root, ["latitude"]));
    const longitude = Number(
      ldGeo?.longitude ?? firstDeep(root, ["longitude"]),
    );
    const externalId = str(firstDeep(root, ["listingId", "id"]));

    let urls = collectImageUrls(root, REA_IMG_HOST);
    if (urls.length === 0) urls = collectImageUrls(jsonLd, REA_IMG_HOST);
    if (urls.length === 0) {
      urls = await page
        .$$eval("img", (imgs) =>
          imgs
            .map((i) => (i as HTMLImageElement).src)
            .filter((s) => /reastatic\.net/i.test(s)),
        )
        .catch(() => [] as string[]);
      urls = [...new Set(urls)];
    }

    const images: NormalizedImage[] = urls.map((sourceUrl, ordinal) => ({
      sourceUrl,
      ordinal,
    }));

    const property: NormalizedProperty = {
      sourceSite: "rea",
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
      raw: { address, priceDisplay, beds, baths, parking, imageCount: images.length },
      status: address || priceDisplay || images.length > 0 ? "ok" : "partial",
    };

    return { property, images };
  },
};
