import fs from "node:fs";
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
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return new Response("Not found", { status: 404 });
  }
  const buf = fs.readFileSync(abs);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": MEDIA_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "private, max-age=60",
    },
  });
}
