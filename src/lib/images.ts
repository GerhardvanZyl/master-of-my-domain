import type { Image } from "@/db/schema";

/**
 * Map a stored image (local_path like "images/<propertyId>/<file>") to the URL
 * served by the /api/img/[...path] route (which reads from IMAGES_DIR).
 */
export function imageUrl(img: Pick<Image, "localPath">): string {
  const rel = img.localPath.replace(/^images[\\/]/, "");
  return `/api/img/${rel.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
}
