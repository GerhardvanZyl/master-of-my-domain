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

/**
 * Bounded-depth walk collecting values for keys matching `keyMatch`. Same
 * spirit as extract.ts's deepCollect, but caps recursion so a probe that only
 * expects a shallow field (e.g. soldDetails.soldDate) can't be tricked into a
 * pathological full-tree walk by a huge payload.
 */
function shallowCollect(
  root: unknown,
  keyMatch: (key: string) => boolean,
  maxDepth: number,
): unknown[] {
  const out: unknown[] = [];
  const visited = new Set<unknown>();
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    if (Array.isArray(node)) {
      if (depth < maxDepth) for (const v of node) stack.push({ node: v, depth: depth + 1 });
      continue;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (keyMatch(k)) out.push(v);
      if (depth < maxDepth) stack.push({ node: v, depth: depth + 1 });
    }
  }
  return out;
}

/** Bounded-depth walk collecting every string leaf value (any key). */
function collectStrings(root: unknown, maxDepth: number): string[] {
  const out: string[] = [];
  const visited = new Set<unknown>();
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    if (!node || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    if (depth >= maxDepth) continue;
    const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const v of values) stack.push({ node: v, depth: depth + 1 });
  }
  return out;
}

/**
 * Normalise a candidate sold-date value (ISO/free-text string, or unix
 * seconds/ms) to "YYYY-MM-DD". Rejects anything that doesn't parse to a real
 * date, and anything in the future (a mis-parsed field is more likely than a
 * listing legitimately selling tomorrow).
 */
function normalizeSoldDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    if (ms > Date.now()) return null;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  // Pure "YYYY-MM-DD" is unambiguous — skip Date.parse entirely so it can't
  // get reinterpreted as UTC midnight and shift a day against local tz.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(t) || t > Date.now() ? null : s;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d.getTime() > Date.now()) return null;
  // Free-text formats ("12 Jul 2025") parse to LOCAL midnight in V8 — read
  // back local date parts, not toISOString (UTC), which can shift a day.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SOLD_DATE_KEYS = new Set(["solddate", "datesold", "soldon"]);

/** Rung 1: any *soldDate/dateSold/soldOn key anywhere in the object graph. */
function keySoldDate(root: unknown): string | null {
  for (const v of shallowCollect(root, (k) => SOLD_DATE_KEYS.has(k.toLowerCase()), 6)) {
    const n = normalizeSoldDate(v);
    if (n) return n;
  }
  return null;
}

/** JSON-LD blocks found directly on `payload.jsonLd`, or `payload` itself if it's already the block array. */
function extractJsonLdBlocks(payload: unknown): Record<string, unknown>[] {
  const rec = asRecord(payload);
  const arr = rec && Array.isArray(rec.jsonLd) ? rec.jsonLd : Array.isArray(payload) ? payload : [];
  return arr.map(asRecord).filter((o): o is Record<string, unknown> => o !== null);
}

/** Rung 2: a JSON-LD offer whose availability reads "sold" (schema.org SoldOut). */
function ldSoldDate(blocks: Record<string, unknown>[]): string | null {
  for (const block of blocks) {
    const offers = asRecord(block.offers);
    const availability = str(offers?.availability) ?? str(block.availability);
    if (!availability || !/sold/i.test(availability)) continue;
    const candidate =
      offers?.priceValidUntil ?? offers?.validThrough ?? block.datePosted ?? block.dateModified;
    const n = normalizeSoldDate(candidate);
    if (n) return n;
  }
  return null;
}

const SOLD_TEXT_RES: RegExp[] = [
  /sold\b[^.]{0,30}?(\d{1,2}\s+\w{3,9}\s+\d{4})/i,
  /sold\s+on\s+([^.\n]{4,40})/i,
];

/** Rung 3: free text like "Sold on 12 Jul 2025" / "Sold at auction 12 July 2025". */
function freeTextSoldDate(root: unknown): string | null {
  for (const s of collectStrings(root, 8)) {
    for (const re of SOLD_TEXT_RES) {
      const m = s.match(re);
      if (!m) continue;
      const n = normalizeSoldDate(m[1]);
      if (n) return n;
    }
  }
  return null;
}

/**
 * The real sale date for a sold Domain listing, or null if it can't be found
 * in the payload — callers should fall back to today's date (detection date)
 * rather than block on this. `payload` can be the raw listing-page data
 * (nextData/jsonLd shape), a bare object such as `{ soldDetails: {...} }`, or
 * any nested fragment thereof; every rung walks whatever it's given.
 * Probes, in order: (1) a `soldDate`/`dateSold`/`soldOn` key anywhere in the
 * object graph, (2) JSON-LD offers marked sold, (3) free text like "Sold on
 * 12 Jul 2025".
 */
export function soldDate(payload: unknown): string | null {
  if (payload == null) return null;
  return (
    keySoldDate(payload) ??
    ldSoldDate(extractJsonLdBlocks(payload)) ??
    freeTextSoldDate(payload)
  );
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
      alt: raw.imgAlts?.[sourceUrl] ?? null,
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
