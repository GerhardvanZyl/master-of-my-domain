import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import probe from "probe-image-size";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { images } from "@/db/schema";
import { IMAGES_DIR } from "@/lib/env";
import { newId } from "@/lib/id";
import type { NormalizedImage } from "./types";

export interface ImageSyncResult {
  added: number;
  kept: number;
  skippedDup: number;
  failed: number;
}

const EXT_BY_TYPE: Record<string, string> = {
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

function extFromUrl(url: string): string {
  const m = url.split("?")[0].match(/\.(jpe?g|png|webp|gif)$/i);
  return m ? EXT_BY_TYPE[m[1].toLowerCase()] ?? "jpg" : "jpg";
}

async function fetchBuffer(
  url: string,
  referer: string,
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        referer,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Reconcile a property's images against a freshly scraped list.
 * - Existing images (matched by source_url) are KEPT untouched — this preserves
 *   any room tags / similarity-group memberships attached to them.
 * - New source_urls are downloaded, de-duplicated by content hash within the
 *   property, sized, written to disk, and inserted.
 */
export async function syncImages(
  propertyId: string,
  normImages: NormalizedImage[],
  listingUrl: string,
): Promise<ImageSyncResult> {
  const result: ImageSyncResult = { added: 0, kept: 0, skippedDup: 0, failed: 0 };

  const existing = db
    .select()
    .from(images)
    .where(eq(images.propertyId, propertyId))
    .all();
  const bySourceUrl = new Map(existing.map((r) => [r.sourceUrl, r]));
  const hashes = new Set(existing.map((r) => r.contentHash).filter(Boolean));

  const referer = new URL(listingUrl).origin + "/";
  const dir = path.join(IMAGES_DIR, propertyId);
  fs.mkdirSync(dir, { recursive: true });

  // Existing max ordinal, so newly added images append after current ones.
  let ordinal = existing.reduce((m, r) => Math.max(m, r.ordinal + 1), 0);

  for (const img of normImages) {
    if (bySourceUrl.has(img.sourceUrl)) {
      result.kept++;
      continue;
    }
    const buf = await fetchBuffer(img.sourceUrl, referer);
    if (!buf || buf.length === 0) {
      result.failed++;
      continue;
    }
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (hashes.has(hash)) {
      result.skippedDup++;
      continue;
    }

    let width: number | null = null;
    let height: number | null = null;
    let ext = extFromUrl(img.sourceUrl);
    try {
      const dims = probe.sync(buf);
      if (dims) {
        width = dims.width ?? null;
        height = dims.height ?? null;
        ext = EXT_BY_TYPE[dims.type] ?? ext;
      }
    } catch {
      /* keep url-derived ext, null dims */
    }

    const id = newId("img");
    const rel = path.join("images", propertyId, `${id}.${ext}`);
    const abs = path.join(IMAGES_DIR, propertyId, `${id}.${ext}`);
    fs.writeFileSync(abs, buf);

    db.insert(images)
      .values({
        id,
        propertyId,
        sourceUrl: img.sourceUrl,
        localPath: rel,
        contentHash: hash,
        ordinal: ordinal++,
        width,
        height,
        bytes: buf.length,
        createdAt: new Date().toISOString(),
      })
      .run();
    hashes.add(hash);
    result.added++;
  }

  return result;
}
