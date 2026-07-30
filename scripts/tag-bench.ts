import "../src/lib/load-env";
import fs from "node:fs";
import path from "node:path";
import { parseFlags, parsePositiveNumber } from "../src/lib/args";
import { listTaggedImages, topTaggedProperties } from "../src/db/queries/tags";
import { classifyRoom, DEFAULT_VISION_MODEL } from "../src/lib/room-classify";
import { DATA_DIR } from "../src/lib/env";
import { renderReport, type BenchRow } from "../src/lib/bench-report";

/**
 * Measures a local vision model against the room tags already in the DB.
 * READ-ONLY: this file must never import a write helper. Its whole job is to
 * tell you which --threshold to give tag:auto.
 */

const f = parseFlags(process.argv.slice(2));
const model = typeof f.model === "string" ? f.model : DEFAULT_VISION_MODEL;

/** M7: a typo'd --count/--limit must fail loudly, not silently disable the LIMIT clause. */
function parsePositiveInt(raw: unknown, flagName: string): number | undefined {
  try {
    return parsePositiveNumber(raw as string | boolean | undefined, flagName);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const count = parsePositiveInt(f.count, "count") ?? 10;
const limit = parsePositiveInt(f.limit, "limit");

const propertiesFlag = typeof f.properties === "string" ? f.properties : undefined;
const ids = propertiesFlag
  ? propertiesFlag.split(",").map((s) => s.trim()).filter(Boolean)
  : topTaggedProperties(count);

const images = listTaggedImages({ propertyIds: ids, limit });
if (images.length === 0) {
  console.error("No tagged images matched — check --properties ids.");
  process.exit(1);
}

// Progress goes to stderr so `npm run tag:bench > report.txt` keeps the report clean.
console.error(
  `Benchmarking ${model} over ${images.length} photos from ${ids.length} properties…`,
);

const outPath = path.join(DATA_DIR, "_tagbench.jsonl");
const rows: BenchRow[] = [];
let failed = 0;
let consecutiveFailures = 0;
let aborted = false;
let abortReason: string | undefined;
const started = Date.now();

for (const [i, img] of images.entries()) {
  try {
    const v = await classifyRoom(img.absPath, model);
    rows.push({
      imageId: img.imageId,
      truth: img.roomType,
      got: v.room,
      confidence: v.confidence,
    });
    consecutiveFailures = 0;

    // M1: a locked/unwritable jsonl file is a logging problem, not a
    // classification failure — keep it out of the classify try/catch so it
    // can't double-count a photo as both classified and errored.
    try {
      fs.appendFileSync(
        outPath,
        JSON.stringify({
          model,
          imageId: img.imageId,
          truth: img.roomType,
          ...v,
        }) + "\n",
      );
    } catch (appendErr) {
      const why =
        appendErr instanceof Error ? appendErr.message : String(appendErr);
      console.error(`  ! could not append ${img.imageId} to ${outPath}: ${why}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not reachable/i.test(msg)) {
      // A dead server is not a per-image problem — stop instead of printing
      // 445 copies. C1: still render whatever the run measured before exiting.
      // Count this photo as errored so the abort banner doesn't read
      // "0 errored" next to a call that in fact failed.
      console.error(msg);
      failed++;
      aborted = true;
      abortReason = msg;
      break;
    }
    failed++;
    consecutiveFailures++;
    console.error(`  ! ${img.imageId}: ${msg}`);
    // I2: a mid-run failure mode (model unloaded, OOM, timeouts) that doesn't
    // match /not reachable/i must not be allowed to grind through the whole
    // sample one bad photo at a time.
    if (consecutiveFailures >= 10) {
      abortReason = `Aborting: ${consecutiveFailures} consecutive failures — is the model still loaded and vision-capable?`;
      console.error(abortReason);
      aborted = true;
      break;
    }
  }
  if ((i + 1) % 25 === 0) {
    const rate = (Date.now() - started) / 1000 / (i + 1);
    console.error(
      `  …${i + 1}/${images.length} (${rate.toFixed(1)}s/photo, ~${Math.round((rate * (images.length - i - 1)) / 60)}min left)`,
    );
  }
}

// C1 / I3: the report is rendered and printed exactly once, on every exit
// path (success, dead-server abort, or circuit-breaker abort) — never lost
// behind a process.exit() called before stdout was written.
const report = renderReport(rows, failed, {
  model,
  elapsedMs: Date.now() - started,
  outPath,
  propertyCount: ids.length,
  photoCount: images.length,
  limit,
  propertiesFlag,
  timestamp: new Date(started).toISOString(),
  aborted,
  abortReason,
});
console.log(report);

// M2: a run that classified nothing is a failure, not a silent success.
if (rows.length === 0 || aborted) {
  process.exitCode = 1;
}
