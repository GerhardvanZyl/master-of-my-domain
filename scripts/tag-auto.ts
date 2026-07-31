import "../src/lib/load-env";
import {
  parseFlags,
  parsePositiveNumber,
  parseUnitInterval,
} from "../src/lib/args";
import {
  classifyRoom,
  passesGate,
  DEFAULT_VISION_MODEL,
} from "../src/lib/room-classify";
import {
  classifyFailure,
  circuitBreakerMessage,
  progressLine,
  shouldReportProgress,
  CONSECUTIVE_FAILURE_LIMIT,
} from "../src/lib/tagging-run";

/**
 * First-pass room tagging by a local vision model. Only ever reads UNTAGGED
 * images, so existing tags cannot be overwritten. Confident verdicts are
 * written insert-if-absent (so a hand tag made mid-run, via the UI or
 * `tag:set`, always wins over this script); the rest are printed as a
 * review queue for Claude to Read.
 *
 * All flag validation happens before any DB access — the query module (and
 * with it the SQLite connection) is imported dynamically, only after every
 * flag has passed, so "no DB access on a bad flag" holds literally.
 */

const USAGE =
  "Usage: npm run tag:auto -- --threshold=<0..1> [--property=<id>] [--limit=N] [--model=<name>] [--dry-run]\n" +
  "\nThere is no default threshold on purpose. Run `npm run tag:bench` first and\n" +
  "read the value off its confidence table.";

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

/** Runs a strict parser and turns any throw into the standard usage failure. */
function must<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const KNOWN_FLAGS = new Set([
  "threshold",
  "property",
  "limit",
  "model",
  "dry-run",
]);

const TRUTHY_DRY_RUN = new Set(["true", "1", "yes", "on"]);

/**
 * `--dry-run` must fail closed: anything other than the bare flag or a
 * recognised truthy spelling is rejected rather than silently defaulting to
 * "write". A typo'd value must not quietly behave like the flag was never
 * given.
 */
function parseDryRun(raw: string | boolean | undefined): boolean {
  if (raw === undefined) return false;
  if (raw === true) return true;
  // `raw` is `string | false` here — parseFlags never actually produces
  // `false`, but the `typeof` check (rather than an `as string` cast) keeps
  // this correct under the type as declared, and satisfies `tsc --noEmit`
  // (a bare `.trim()` here does not typecheck against `string | false`).
  if (typeof raw === "string" && TRUTHY_DRY_RUN.has(raw.trim().toLowerCase())) {
    return true;
  }
  throw new Error(
    `Invalid --dry-run=${JSON.stringify(raw)} — expected true/1/yes/on (or bare --dry-run).`,
  );
}

const f = parseFlags(process.argv.slice(2));

const unknownFlags = Object.keys(f).filter((k) => !KNOWN_FLAGS.has(k));
if (unknownFlags.length > 0) {
  fail(`Unknown flag(s): ${unknownFlags.map((k) => `--${k}`).join(", ")}`);
}

const threshold = must(() => parseUnitInterval(f.threshold, "threshold"));
const limit = must(() => parsePositiveNumber(f.limit, "limit"));
const dryRun = must(() => parseDryRun(f["dry-run"]));
const model = typeof f.model === "string" ? f.model : DEFAULT_VISION_MODEL;
const propertyId = typeof f.property === "string" ? f.property : undefined;

// Only now, with every flag validated, do we touch the database.
const { listUntaggedImages, setImageTagIfAbsent, propertyHasImages } =
  await import("../src/db/queries/tags");

const images = listUntaggedImages({ propertyId, limit });

if (images.length === 0) {
  if (propertyId && !propertyHasImages(propertyId)) {
    // Silent narrowing (an unknown/mistyped --property quietly matching
    // nothing) is the same bug class as silent widening — fail loudly.
    // But an unknown id and a known id that's just fully tagged are
    // different problems: only the former means "check the id".
    console.error(
      `No untagged images found for --property=${propertyId} — check the id.`,
    );
    process.stdout.write("[]\n");
    process.exit(1);
  }
  console.error("Nothing untagged. Done.");
  process.stdout.write("[]\n");
  process.exit(0);
}

console.error(
  `${dryRun ? "[dry-run] " : ""}${model} over ${images.length} untagged photos, threshold ${threshold}…`,
);

const queue: Array<Record<string, unknown>> = [];
let wrote = 0;
let ruleWrote = 0;
let skipped = 0;
let failed = 0;
let consecutiveFailures = 0;
const started = Date.now();

for (const [i, img] of images.entries()) {
  let v;
  try {
    v = await classifyRoom(img.absPath, model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = classifyFailure(msg);
    // A dead server or a missing ffmpeg means abort, not 300 identical errors.
    if (kind === "not-reachable" || kind === "ffmpeg-missing") {
      console.error(msg);
      console.error(`Stopped after writing ${wrote} tags.`);
      process.exitCode = 1;
      break;
    }
    failed++;
    console.error(`  ! ${img.imageId}: ${msg}`);
    // An unreadable file (pruned/missing image) is a per-photo data problem,
    // not evidence the model server is sick — it must not feed the breaker,
    // or a property with 10 pruned photos aborts the whole run for no
    // model-side reason. It still counts toward `failed` above.
    if (kind === "unreadable-image") {
      continue;
    }
    consecutiveFailures++;
    // A run-wide model-side failure mode (unloaded, wrong --model, OOM, HTTP
    // 500) doesn't match "not reachable" and must not be allowed to grind
    // through the whole set one bad photo at a time.
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      console.error(circuitBreakerMessage(consecutiveFailures));
      console.error(`Stopped after writing ${wrote} tags.`);
      process.exitCode = 1;
      break;
    }
    continue;
  }
  consecutiveFailures = 0;

  if (passesGate(v, threshold)) {
    if (dryRun) {
      wrote++;
    } else {
      const inserted = setImageTagIfAbsent({
        imageId: img.imageId,
        roomType: v.room,
        confidence: v.confidence,
        taggedBy: "local-vlm",
        notes: v.source === "rule" ? "rule:svg" : `local:${model}`,
      });
      if (inserted) {
        wrote++;
        if (v.source === "rule") ruleWrote++;
      } else skipped++; // tagged by someone else while this run was in flight
    }
  } else {
    queue.push({ ...img, suggested: v.room, confidence: v.confidence });
  }

  if (shouldReportProgress(i)) {
    console.error(progressLine(i, images.length, started));
  }
}

console.error(
  `${dryRun ? "[dry-run] would tag" : "tagged"} ${wrote} (${ruleWrote} rule-tagged SVG -> other, ${wrote - ruleWrote} model-tagged), ` +
    `${skipped} skipped (already tagged), queued ${queue.length} for review, ${failed} errored`,
);
// Same JSON shape as tag:list, so Claude's existing loop consumes it
// unchanged. Printed on every exit path (success, dead-server abort, or
// circuit-breaker abort) via process.exitCode rather than process.exit(), so
// a large queue can never be truncated by an early hard exit.
process.stdout.write(JSON.stringify(queue, null, 2) + "\n");

// A run that classified nothing is a failure, not a silent success — a
// caller must not see exit 0 + "[]" and read that as "everything tagged".
if (wrote === 0 && queue.length === 0 && failed > 0) {
  process.exitCode = 1;
}
