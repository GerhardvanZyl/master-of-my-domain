import type { Adapter } from "./base";
import { ScrapeError, parsePrice } from "./base";
import type {
  ExtractResult,
  NormalizedImage,
  NormalizedProperty,
  RawPageData,
} from "../types";
import { collectImageUrls } from "../extract";

// Broad candidate net — matches both the real gallery host (i2.au.reastatic.net)
// and the UI-asset host (argonaut.au.reastatic.net) so nothing is dropped before
// parseReaImage() applies the strict host/filename/width rules below.
const REA_IMG_HOST = /reastatic\.net/i;

// Strict gallery-image validator. Requires:
//  - host i<digits>.au.reastatic.net (excludes argonaut.au.reastatic.net, which
//    serves UI svgs, not photos)
//  - filename exactly image.<ext> (excludes logo.jpg, main.jpg — the agency
//    logo and agent headshot)
//  - rendered width (leading size-segment number, before the first "x") >= 600
//    (excludes 310x175 similar-listing cards and the 200x200 headshot)
const REA_IMAGE_RE =
  /^https:\/\/i\d+\.au\.reastatic\.net\/(\d+)x\d+[^/]*\/([0-9a-f]+)\/image\.[a-z0-9]+(?:[?#].*)?$/i;

interface ParsedReaImage {
  url: string;
  width: number;
  hash: string;
}

function parseReaImage(url: string): ParsedReaImage | null {
  const m = url.match(REA_IMAGE_RE);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  if (!Number.isFinite(width) || width < 600) return null;
  return { url, width, hash: m[2] };
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
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

/** "<street>, <locality>, <region> <postcode>" — Residence.name is street-only, never use it. */
function composeAddress(
  street: string | null,
  locality: string | null,
  region: string | null,
  postcode: string | null,
): string | null {
  if (!street) return null;
  const cityLine = [locality, [region, postcode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return cityLine ? `${street}, ${cityLine}` : street;
}

/** Event.organizer.name from the first Event block that has one, or null if none do. */
function agencyNameFromEvents(eventBlocks: Record<string, unknown>[]): string | null {
  for (const b of eventBlocks) {
    const organizer = asRecord(b.organizer);
    const name = str(organizer?.name);
    if (name) return name;
  }
  return null;
}

/**
 * Earliest still-relevant Event.startDate across zero, one or several Event
 * blocks. "Next" = soonest still-relevant time (keep today's earlier slot
 * visible) — same cutoff as nextInspection() in domain.ts, for parity.
 */
function earliestEventStart(eventBlocks: Record<string, unknown>[]): string | null {
  const times = eventBlocks
    .map((b) => str(b.startDate))
    .filter((s): s is string => s !== null)
    .map((s) => Date.parse(s))
    .filter((t) => !Number.isNaN(t));
  const cutoff = Date.now() - 6 * 3600_000;
  const upcoming = times.filter((t) => t >= cutoff).sort((a, b) => a - b);
  return upcoming.length ? new Date(upcoming[0]).toISOString() : null;
}

/**
 * beds/baths/parking/landSizeSqm/propertyType all live in one composite
 * aria-label, e.g. "House with 701m² land size with 4 bedrooms with study
 * 2 bathrooms 2 car spaces". Each quantity is parsed by its OWN regex — never
 * positionally — because land size is absent on some listings and "with
 * study" can interject between beds and baths. Only the FIRST aria-label
 * mentioning bedrooms counts; later ones of the same shape belong to
 * similar-listing cards further down the page.
 */
function parseSummaryAria(ariaLabels: string[]): {
  propertyType: string | null;
  beds: number | null;
  baths: number | null;
  parking: number | null;
  landSizeSqm: number | null;
} {
  const label = ariaLabels.find((l) => /bedrooms?/i.test(l));
  if (!label) {
    return { propertyType: null, beds: null, baths: null, parking: null, landSizeSqm: null };
  }
  const typeMatch = label.match(/^(.*?)\s+with\s+/i);
  const bedsMatch = label.match(/(\d+)\s*bedrooms?/i);
  const bathsMatch = label.match(/(\d+)\s*bathrooms?/i);
  const parkingMatch = label.match(/(\d+)\s*car\s*spaces?/i);
  const landMatch = label.match(/(\d+(?:\.\d+)?)\s*m(?:²|2)\s*land size/i);
  return {
    propertyType: typeMatch ? typeMatch[1].trim() : null,
    beds: bedsMatch ? parseInt(bedsMatch[1], 10) : null,
    baths: bathsMatch ? parseInt(bathsMatch[1], 10) : null,
    parking: parkingMatch ? parseInt(parkingMatch[1], 10) : null,
    landSizeSqm: landMatch ? Math.round(parseFloat(landMatch[1])) : null,
  };
}

const NON_PRICE_DISPLAY_RE =
  /Contact Agent|Auction|Offers|Price on [Aa]pplication|Under offer/i;

/**
 * REA prints its own budget calculator futher down every listing page ("Your
 * monthly budget / Repayments $4,056 / Expenses $5,000"). On a listing that
 * DOES advertise a price, first-match is enough — the asking price appears
 * above it. On a listing that does not ("Under offer", "Contact Agent"), the
 * calculator's monthly figure becomes the first $-run on the page, and
 * first-match alone stores $4,056 as the asking price. So cut the calculator
 * section off before looking at all, and let the no-price fallback fire.
 */
const CALCULATOR_RE = /Your monthly budget|Repayment calculator|Estimated property price/i;

function priceFromBodyText(bodyText: string): string | null {
  const beforeCalculator = bodyText.split(CALCULATOR_RE)[0];
  const priceMatch = beforeCalculator.match(/\$[\d,]+(?:\.\d+)?(?:\s*-\s*\$[\d,]+(?:\.\d+)?)?/);
  if (priceMatch) return priceMatch[0];
  const fallback = beforeCalculator.match(NON_PRICE_DISPLAY_RE);
  return fallback ? fallback[0] : null;
}

/** Trailing digits of the listing URL, e.g. ".../point+cook-152196328" -> "152196328". */
function externalIdFromUrl(url: string): string | null {
  const bare = url.split(/[?#]/)[0].replace(/\/+$/, "");
  const m = bare.match(/(\d+)$/);
  return m ? m[1] : null;
}

const AU_STATE_ABBRS = new Set(["nsw", "vic", "qld", "wa", "sa", "tas", "act", "nt"]);

/**
 * REA listing URLs are shaped
 * ".../property-<type words>-<state>-<suburb[+with+plus+for+spaces]>-<externalId>"
 * (e.g. ".../property-house-vic-point+cook-151945812"). Used only when there's
 * no JSON-LD Residence block to fall back on — an "address available on
 * request" listing still discloses its state and suburb via the URL.
 *
 * This runs on untrusted scraped input, so any slug that doesn't match the
 * expected shape degrades to nulls rather than guessing or throwing: never
 * emit a partial fragment as a suburb.
 */
function deriveFromReaSlug(url: string): { state: string | null; suburb: string | null } {
  const bare = url.split(/[?#]/)[0].replace(/\/+$/, "");
  const last = bare.split("/").pop();
  if (!last) return { state: null, suburb: null };

  const parts = last.split("-");
  if (parts.length < 2 || !/^\d+$/.test(parts[parts.length - 1])) {
    return { state: null, suburb: null };
  }

  const body = parts.slice(0, -1); // drop the trailing external id
  const stateIdx = body.findIndex((s) => AU_STATE_ABBRS.has(s.toLowerCase()));
  if (stateIdx === -1) return { state: null, suburb: null };

  const state = body[stateIdx].toUpperCase();
  const suburb = body
    .slice(stateIdx + 1)
    .join(" ")
    .split(/[+ ]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return { state, suburb: suburb || null };
}

/** og:description carries the full description but with <br/> markup — strip to plain text. */
function stripHtml(s: string): string | null {
  const plain = s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
  return plain || null;
}

export const ReaAdapter: Adapter = {
  site: "rea",
  matches(hostname) {
    return /(^|\.)realestate\.com\.au$/i.test(hostname);
  },
  normalize(raw: RawPageData): ExtractResult {
    const jsonLd = raw.jsonLd ?? [];
    const ldBlocks = jsonLd
      .map(asRecord)
      .filter((o): o is Record<string, unknown> => o !== null);

    const hasDomBag = Boolean(
      raw.bodyText || (raw.ariaLabels && raw.ariaLabels.length > 0) || raw.ogDescription,
    );
    if (ldBlocks.length === 0 && !hasDomBag) {
      throw new ScrapeError(
        "No JSON-LD or usable DOM data found for realestate.com.au — likely blocked or shape changed.",
      );
    }

    // Pick by @type, never by array position — the block order isn't guaranteed.
    const residence = ldBlocks.find((b) => b["@type"] === "Residence");
    const eventBlocks = ldBlocks.filter((b) => b["@type"] === "Event");

    const ldAddress = asRecord(residence?.address);
    // The only source of `address`. Null whenever REA withholds the street
    // address ("Address available on request"), which is also when
    // `residence` itself is absent — and it MUST stay null in that case, never
    // fall back to og:title ("Address available on request, Seabrook") or any
    // other display stand-in: addressKey (src/scrape/persist.ts) keys
    // twin-matching on `address`, so a stand-in string collapses every
    // withheld-address listing in the same suburb onto one key and silently
    // merges distinct houses. The UI falls back to suburb on its own
    // (propertyTitle, src/lib/format.ts), so nothing is lost by leaving this
    // null.
    const residenceAddress = composeAddress(
      str(ldAddress?.streetAddress),
      str(ldAddress?.addressLocality),
      str(ldAddress?.addressRegion),
      str(ldAddress?.postalCode),
    );
    const postcode = str(ldAddress?.postalCode);

    // No Residence block: the page still discloses state/suburb via the URL
    // slug — surface those rather than leaving every field null.
    const slugFallback = residence ? null : deriveFromReaSlug(raw.url);
    const suburb = str(ldAddress?.addressLocality) ?? slugFallback?.suburb ?? null;
    const state = str(ldAddress?.addressRegion) ?? slugFallback?.state ?? null;

    const nextInspection = earliestEventStart(eventBlocks);

    const ariaLabels = raw.ariaLabels ?? [];
    const { propertyType, beds, baths, parking, landSizeSqm } = parseSummaryAria(ariaLabels);

    const bodyText = raw.bodyText ?? "";
    const priceDisplay = priceFromBodyText(bodyText);

    const description = raw.ogDescription ? stripHtml(raw.ogDescription) : null;

    const externalId = externalIdFromUrl(raw.url);

    // Not present on REA listing pages at all — leave null rather than invent a source.
    const latitude: number | null = null;
    const longitude: number | null = null;
    // Event.organizer is the listing agency; absent when there's no Event block.
    const agencyName = agencyNameFromEvents(eventBlocks);
    // No agent-identifying field exists on RawPageData (deliberately not adding
    // a REA-specific collector for it) — null.
    const agentName: string | null = null;

    // Candidate gallery URLs: embedded JSON (forward-compat, currently empty on
    // REA), JSON-LD (Event.image[*]), and the DOM <img> harvest.
    const candidates = [
      ...collectImageUrls(raw.nextData ?? raw.globals ?? {}, REA_IMG_HOST),
      ...collectImageUrls(jsonLd, REA_IMG_HOST),
      ...(raw.imgUrls ?? []).filter((s) => REA_IMG_HOST.test(s)),
    ];

    // Dedupe by CDN hash, keeping the largest width, preserving first-seen order.
    const byHash = new Map<string, ParsedReaImage>();
    const hashOrder: string[] = [];
    for (const url of candidates) {
      const parsed = parseReaImage(url);
      if (!parsed) continue;
      const existing = byHash.get(parsed.hash);
      if (!existing) {
        byHash.set(parsed.hash, parsed);
        hashOrder.push(parsed.hash);
      } else if (parsed.width > existing.width) {
        byHash.set(parsed.hash, parsed);
      }
    }

    // pickHero (src/db/queries/properties.ts) ranks images via urlIds(), which
    // parses Domain's CDN filename and returns null for REA — so for REA,
    // ordinal 0 IS the hero. The cover is og:image first, falling back to
    // Event.image[0] — listings with no scheduled inspection have no Event
    // block at all, so og:image is the only cover source for those. Both are
    // the same URL when both exist.
    const heroUrl: unknown =
      raw.ogImage ?? (eventBlocks.length ? asArray(eventBlocks[0].image)[0] : undefined);
    const heroHash =
      typeof heroUrl === "string" ? parseReaImage(heroUrl)?.hash ?? null : null;
    const orderedHashes =
      heroHash && byHash.has(heroHash)
        ? [heroHash, ...hashOrder.filter((h) => h !== heroHash)]
        : hashOrder;

    const images: NormalizedImage[] = orderedHashes.map((hash, ordinal) => {
      const p = byHash.get(hash)!;
      return { sourceUrl: p.url, ordinal, alt: raw.imgAlts?.[p.url] ?? null };
    });

    const property: NormalizedProperty = {
      sourceSite: "rea",
      listingUrl: raw.url,
      externalId,
      address: residenceAddress,
      suburb,
      state,
      postcode,
      priceDisplay,
      priceNumeric: parsePrice(priceDisplay),
      beds,
      baths,
      parking,
      landSizeSqm,
      propertyType,
      agentName,
      agencyName,
      description,
      latitude,
      longitude,
      nextInspection,
      raw: {
        address: residenceAddress,
        priceDisplay,
        beds,
        baths,
        parking,
        landSizeSqm,
        propertyType,
        imageCount: images.length,
      },
      // Essentials must ALL come through for "ok" — an address alone (the
      // pre-fix failure mode) must report "partial", not "ok". A withheld
      // listing's `address` is already null (see above), so this simply reads
      // as "and address is present" — no separate stand-in to guard against.
      status: residenceAddress && priceDisplay && beds != null ? "ok" : "partial",
    };

    return { property, images };
  },
};
