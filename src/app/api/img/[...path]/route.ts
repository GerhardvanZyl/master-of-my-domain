import fs from "node:fs";
import path from "node:path";
import { IMAGES_DIR } from "@/lib/env";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const rel = segments.map((s) => decodeURIComponent(s)).join("/");
  const abs = path.resolve(IMAGES_DIR, rel);

  // Path-traversal guard: resolved path must stay inside IMAGES_DIR.
  const root = path.resolve(IMAGES_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return new Response("Not found", { status: 404 });
  }

  const buf = fs.readFileSync(abs);
  const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": type,
      // Files are content-unique (id-named, never rewritten) — safe to cache forever.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
