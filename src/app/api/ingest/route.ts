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

/**
 * Read the payload as JSON, or — when the request is a form POST — from a
 * `payload` field holding the JSON string. The form path lets a listing page
 * hand over its (large) embedded data via a top-level form-submit navigation to
 * localhost, which sidesteps both the URL-length ceiling of a hash bridge and
 * the Private-Network-Access block on a cross-origin fetch.
 */
async function readPayload(req: Request): Promise<RawPageData | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form-urlencoded") || ct.includes("form-data")) {
    const fd = await req.formData().catch(() => null);
    const s = fd?.get("payload");
    if (typeof s !== "string") return null;
    try {
      return JSON.parse(s) as RawPageData;
    } catch {
      return null;
    }
  }
  return (await req.json().catch(() => null)) as RawPageData | null;
}

export async function POST(req: Request) {
  const raw = await readPayload(req);
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
  let propertyId: string | null = null;
  try {
    const { property, images } = adapter.normalize(raw);
    propertyId = upsertProperty(property, { status: property.status ?? "ok" });
    const imgResult = await syncImages(propertyId, images, raw.url);
    logIngest(raw.url, propertyId, null);
    return NextResponse.json({ ok: true, propertyId, images: imgResult });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logIngest(raw.url, propertyId, message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: err instanceof ScrapeError ? 422 : 500 },
    );
  }
}
