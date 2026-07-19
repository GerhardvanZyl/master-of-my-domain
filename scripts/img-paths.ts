import "../src/lib/load-env";
import path from "node:path";
import { db } from "../src/db/client";
import { images } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { IMAGES_DIR } from "../src/lib/env";

// Print "<imageId>\t<absPath>" for a property's images, ordered. Helper for the
// photo-tagging loop. Usage: npx tsx scripts/img-paths.ts <propertyId>
const pid = process.argv[2];
const rows = db
  .select({ id: images.id, ordinal: images.ordinal, localPath: images.localPath })
  .from(images)
  .where(eq(images.propertyId, pid))
  .all()
  .sort((a, b) => a.ordinal - b.ordinal);
for (const r of rows) {
  const abs = path.resolve(IMAGES_DIR, "..", r.localPath);
  console.log(`${r.id}\t${abs}`);
}
