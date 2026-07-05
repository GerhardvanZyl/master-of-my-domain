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

/** Parse the first integer out of a string, or null. */
export function firstInt(s: unknown): number | null {
  if (typeof s === "number" && Number.isFinite(s)) return Math.trunc(s);
  if (typeof s !== "string") return null;
  const m = s.replace(/,/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/** Best-effort AUD parse: "$1,250,000" -> 1250000; "$1.2m" -> 1200000. */
export function parsePrice(s: unknown): number | null {
  if (typeof s === "number" && Number.isFinite(s)) return Math.trunc(s);
  if (typeof s !== "string") return null;
  const lower = s.toLowerCase();
  // (?![a-z]) so a trailing word ("$550,000 median") isn't read as a multiplier.
  const m = lower.match(/\$?\s*([\d,.]+)(?:\s*(m|k)(?![a-z]))?/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  if (m[2] === "m") return Math.round(num * 1_000_000);
  if (m[2] === "k") return Math.round(num * 1_000);
  return Math.round(num);
}
