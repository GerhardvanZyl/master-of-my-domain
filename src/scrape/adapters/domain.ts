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

/** Epoch ms from a unix number (s or ms) or a parseable date string. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v))
    return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Start datetime (ms) of one inspection entry, across Domain's shape variants. */
function inspectionStart(item: unknown): number | null {
  const direct = toMs(item);
  if (direct != null) return direct;
  const r = asRecord(item);
  if (!r) return null;
  const oh = asRecord(r.openingHours);
  return toMs(
    r.openingTime ??
      r.openTime ??
      r.startTime ??
      r.start ??
      r.begins ??
      r.dateTime ??
      r.date ??
      r.startDate ??
      (oh ? (oh.begins ?? oh.start ?? oh.from) : null),
  );
}

/**
 * Deep-walk the embedded data for the soonest UPCOMING open-for-inspection.
 * Collects times from any `*inspection*` key (array or object) plus schema.org
 * Event blocks, then returns the earliest that isn't already well past.
 * ponytail: Date.parse trusts the source's tz offset; a tz-less string is read
 * as server-local — fine while every Domain listing here is Melbourne.
 */
function nextInspection(...roots: unknown[]): string | null {
  const times: number[] = [];
  const visited = new Set<unknown>();
  const stack: unknown[] = [...roots];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec["@type"] === "string" && /event/i.test(rec["@type"])) {
      const t = inspectionStart(rec);
      if (t != null) times.push(t);
    }
    for (const [k, v] of Object.entries(rec)) {
      if (/inspection/i.test(k)) {
        for (const item of Array.isArray(v) ? v : [v]) {
          const t = inspectionStart(item);
          if (t != null) times.push(t);
        }
      }
      stack.push(v);
    }
  }
  // "Next" = soonest still-relevant time (keep today's earlier slot visible).
  const cutoff = Date.now() - 6 * 3600_000;
  const upcoming = times.filter((t) => t >= cutoff).sort((a, b) => a - b);
  return upcoming.length ? new Date(upcoming[0]).toISOString() : null;
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

    // Domain emits several JSON-LD blocks and the site/Organization one (whose
    // `name` is literally "Domain") often comes first — prefer the block that
    // actually carries an address, or we label every property "Domain".
    const ldBlocks = jsonLd
      .map(asRecord)
      .filter((o): o is Record<string, unknown> => o !== null);
    const ld: Record<string, unknown> | undefined =
      ldBlocks.find((o) => asRecord(o.address) !== null) ?? ldBlocks[0];
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
      nextInspection: nextInspection(root, jsonLd),
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
