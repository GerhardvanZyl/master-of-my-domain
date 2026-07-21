import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR } from "./env";

export interface MediaItem {
  name: string;
  url: string;
  video: boolean;
}

export const MEDIA_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Strip anything that could escape the property folder, keep it recognisable. */
export function safeName(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(-120);
}

export function mediaDirFor(propertyId: string): string | null {
  const dir = path.resolve(MEDIA_DIR, safeName(propertyId));
  const root = path.resolve(MEDIA_DIR);
  return dir.startsWith(root + path.sep) ? dir : null;
}

export function listMedia(propertyId: string): MediaItem[] {
  const dir = mediaDirFor(propertyId);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => MEDIA_MIME[path.extname(n).toLowerCase()])
    .sort()
    .map((name) => ({
      name,
      url: `/api/media/${encodeURIComponent(propertyId)}/${encodeURIComponent(name)}`,
      video: (MEDIA_MIME[path.extname(name).toLowerCase()] ?? "").startsWith("video"),
    }));
}
