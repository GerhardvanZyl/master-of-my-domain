import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { listUntaggedImages, setImageTag } from "../src/db/queries/tags";
import {
  classifyRoom,
  passesGate,
  DEFAULT_VISION_MODEL,
} from "../src/lib/room-classify";

/**
 * First-pass room tagging by a local vision model. Only ever reads UNTAGGED
 * images, so existing tags cannot be overwritten. Confident verdicts are
 * written; the rest are printed as a review queue for Claude to Read.
 */

const f = parseFlags(process.argv.slice(2));
const threshold =
  typeof f.threshold === "string" ? Number(f.threshold) : Number.NaN;

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(
    "Usage: npm run tag:auto -- --threshold=<0..1> [--property=<id>] [--limit=N] [--model=<name>] [--dry-run]\n" +
      "\nThere is no default threshold on purpose. Run `npm run tag:bench` first and\n" +
      "read the value off its confidence table.",
  );
  process.exit(1);
}

const model = typeof f.model === "string" ? f.model : DEFAULT_VISION_MODEL;
const dryRun = f["dry-run"] === true || f["dry-run"] === "true";
const images = listUntaggedImages({
  propertyId: typeof f.property === "string" ? f.property : undefined,
  limit: typeof f.limit === "string" ? Number(f.limit) : undefined,
});

if (images.length === 0) {
  console.error("Nothing untagged. Done.");
  process.stdout.write("[]\n");
  process.exit(0);
}

console.error(
  `${dryRun ? "[dry-run] " : ""}${model} over ${images.length} untagged photos, threshold ${threshold}…`,
);

const queue: Array<Record<string, unknown>> = [];
let wrote = 0;
let failed = 0;

for (const img of images) {
  let v;
  try {
    v = await classifyRoom(img.absPath, model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A dead server means abort, not 300 identical errors.
    if (/not reachable/i.test(msg)) {
      console.error(msg);
      console.error(`Stopped after writing ${wrote} tags.`);
      // A caller must get the partial queue rather than nothing — the same
      // JSON shape as the normal exit path, printed before we abort.
      process.stdout.write(JSON.stringify(queue, null, 2) + "\n");
      process.exit(1);
    }
    failed++;
    console.error(`  ! ${img.imageId}: ${msg}`);
    continue;
  }

  if (passesGate(v, threshold)) {
    if (!dryRun) {
      setImageTag({
        imageId: img.imageId,
        roomType: v.room,
        confidence: v.confidence,
        taggedBy: "local-vlm",
        notes: `local:${model}`,
      });
    }
    wrote++;
  } else {
    queue.push({ ...img, suggested: v.room, confidence: v.confidence });
  }
}

console.error(
  `${dryRun ? "[dry-run] would tag" : "tagged"} ${wrote}, queued ${queue.length} for review, ${failed} errored`,
);
// Same JSON shape as tag:list, so Claude's existing loop consumes it unchanged.
process.stdout.write(JSON.stringify(queue, null, 2) + "\n");
