import { newContext } from "./browser";
import { pickAdapter, ScrapeError } from "./adapters";
import type { Adapter } from "./adapters/base";
import { upsertProperty } from "./persist";
import { syncImages, type ImageSyncResult } from "./images";
import type { NormalizedProperty } from "./types";

export interface ScrapeOutcome {
  ok: boolean;
  url: string;
  propertyId?: string;
  status: "ok" | "partial" | "error";
  error?: string;
  images?: ImageSyncResult;
}

/**
 * Full pipeline for a single URL: pick adapter -> render -> extract ->
 * persist property -> download/reconcile images. Never throws; returns a
 * structured outcome so callers (API route / CLI) can report cleanly.
 */
export async function runScrape(
  url: string,
  opts: { adapter?: Adapter } = {},
): Promise<ScrapeOutcome> {
  const adapter = opts.adapter ?? pickAdapter(url);
  if (!adapter) {
    return {
      ok: false,
      url,
      status: "error",
      error: `No adapter for URL (supported: domain.com.au, realestate.com.au)`,
    };
  }

  const context = await newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Give client-side hydration a moment to populate embedded state.
    await page.waitForTimeout(1200);

    const { property, images } = await adapter.extract(page, url);
    const propertyId = upsertProperty(property, {
      status: property.status ?? "ok",
    });
    const imgResult = await syncImages(propertyId, images, url);

    return {
      ok: true,
      url,
      propertyId,
      status: property.status ?? "ok",
      images: imgResult,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wall = err instanceof ScrapeError && err.wall;
    // Record a stub error row so the property appears in the UI with its status.
    const stub: NormalizedProperty = {
      sourceSite: adapter.site,
      listingUrl: url,
      status: "partial",
    };
    let propertyId: string | undefined;
    try {
      propertyId = upsertProperty(stub, {
        status: "error",
        error: message,
      });
    } catch {
      /* ignore secondary failure */
    }
    return {
      ok: false,
      url,
      propertyId,
      status: "error",
      error: wall ? `Anti-bot wall: ${message}` : message,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
