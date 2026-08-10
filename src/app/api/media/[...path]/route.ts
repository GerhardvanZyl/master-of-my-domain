import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR } from "@/lib/env";
import { MEDIA_MIME } from "@/lib/media";

export const runtime = "nodejs";

// Serves your own uploads. Same shape as /api/img, different root.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const abs = path.resolve(MEDIA_DIR, segments.map((s) => decodeURIComponent(s)).join("/"));
  const root = path.resolve(MEDIA_DIR);
  if (!abs.startsWith(root + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  // Async read, same reason as /api/img: your own walk-through videos are tens
  // of MB and the sync trio parked the only Node thread on disk I/O. A
  // directory throws EISDIR, which covers the old isFile() check.
  // ponytail: whole file into memory, no Range support — a phone scrubbing a
  // long video will re-download it. Stream with Range if that ever bites.
  const buf = await fs.readFile(abs).catch(() => null);
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": MEDIA_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "private, max-age=60",
    },
  });
}
