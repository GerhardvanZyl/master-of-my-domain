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

/**
 * Domain's listing gallery (props.pageProps.componentProps.galleryV2.photos)
 * stores each photo as {mobileUrl,tabletUrl,desktopUrl}, each a {"1x","2x"}
 * pair. These signed rimh2 URLs are EXTENSIONLESS (…-w1448-h1086), so the
 * generic collectImageUrls (which requires a .jpg/png/webp suffix) skips them.
 * Deep-walk for those photo objects and take the best (2x desktop) URL.
 */
function galleryUrls(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);
    if (!Array.isArray(node)) {
      const rec = node as Record<string, unknown>;
      const d = rec.desktopUrl ?? rec.tabletUrl ?? rec.mobileUrl;
      const dd = asRecord(d);
      const u = dd ? (dd["2x"] ?? dd["1x"]) : null;
      if (typeof u === "string" && DOMAIN_IMG_HOST.test(u) && !seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
    const values = Array.isArray(node) ? node : Object.values(node as object);
    for (const v of values) stack.push(v);
  }
  return out;
}

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

    // Union of embedded gallery + JSON-LD + DOM <img> srcs (deduped, host-filtered).
    // The extension re-sends as on-demand carousel images load, and syncImages
    // appends new source_urls, so unioning here tops up the gallery over time.
    const urls = [
      ...new Set([
        ...galleryUrls(root),
        ...collectImageUrls(root, DOMAIN_IMG_HOST),
        ...collectImageUrls(jsonLd, DOMAIN_IMG_HOST),
        ...(raw.imgUrls ?? []).filter((s) => DOMAIN_IMG_HOST.test(s)),
      ]),
    ];

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
