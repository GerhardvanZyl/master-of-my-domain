import "../src/lib/load-env";
import fs from "node:fs";
import { parseFlags } from "../src/lib/args";
import { listTaggedImages, setImageTag } from "../src/db/queries/tags";
import { sqlite } from "../src/db/client";
import { classifyRoom, DEFAULT_VISION_MODEL } from "../src/lib/room-classify";

/**
 * One-off migration for the `aerial` + `exclude` vocabulary added on 2026-07-31.
 *
 * Pass 1 (deterministic): every image whose BYTES are SVG is agency branding.
 *   -> `exclude`, so the app stops showing it. Verified: 377 such files, all
 *   currently tagged `other` by hand.
 * Pass 2 (model): every image currently tagged `exterior` is re-examined with
 *   the new prompt; those the model calls `aerial` are re-tagged. Annotated
 *   locality shots were previously being filed under `exterior`.
 *
 * This OVERWRITES hand-assigned tags, which nothing else in this repo does.
 * Take a copy of data/app.db first. Idempotent: re-running changes nothing.
 */

const f = parseFlags(process.argv.slice(2));
const apply = f.apply === true || f.apply === "true";
const model = typeof f.model === "string" ? f.model : DEFAULT_VISION_MODEL;
const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;

if (!apply) console.error("DRY RUN — pass --apply to write. Nothing will change.\n");

const all = listTaggedImages({}) as any[];

/**
 * setImageTag writes `notes = input.notes ?? null`, so omitting notes ERASES
 * them. 254 exterior images carry notes='hero', and others carry hand-written
 * sub-labels ("entry hall", "pantry", "sunroom", "wir", "cbd view"). Preserve
 * whatever is there; provenance for this migration goes in tagged_by instead.
 */
const existingNotes = new Map<string, string | null>(
  (
    sqlite.prepare("SELECT image_id AS id, notes FROM image_tags").all() as {
      id: string;
      notes: string | null;
    }[]
  ).map((r) => [r.id, r.notes]),
);
const keepNotes = (imageId: string, fallback: string) =>
  existingNotes.get(imageId) || fallback;

function isSvg(absPath: string): boolean {
  try {
    const head = fs.readFileSync(absPath).subarray(0, 64).toString("utf8").trimStart().toLowerCase();
    return head.startsWith("<?xml") || head.startsWith("<svg");
  } catch {
    return false;
  }
}

// --- Pass 1: SVG -> exclude -------------------------------------------------
let svgSeen = 0;
let svgChanged = 0;
const svgFrom = new Map<string, number>();

for (const img of all) {
  if (!isSvg(img.absPath)) continue;
  svgSeen++;
  if (img.roomType === "exclude") continue;
  svgFrom.set(img.roomType, (svgFrom.get(img.roomType) ?? 0) + 1);
  svgChanged++;
  if (apply) {
    setImageTag({
      imageId: img.imageId,
      roomType: "exclude",
      confidence: 1,
      taggedBy: "migration",
      notes: keepNotes(img.imageId, "rule:svg"),
    });
  }
}
console.log(`Pass 1 — SVG -> exclude`);
console.log(`  svg files: ${svgSeen}, needing change: ${svgChanged}`);
for (const [from, n] of svgFrom) console.log(`    was "${from}": ${n}`);

// --- Pass 2: exterior -> aerial (model decides) -----------------------------
let exteriors = all.filter((i) => i.roomType === "exterior" && !isSvg(i.absPath));
if (limit && limit > 0) exteriors = exteriors.slice(0, limit);

console.log(`\nPass 2 — re-examining ${exteriors.length} "exterior" images with ${model}`);
const started = Date.now();
let aerial = 0;
let kept = 0;
let failed = 0;
const otherVerdicts = new Map<string, number>();

for (const [i, img] of exteriors.entries()) {
  let v;
  try {
    v = await classifyRoom(img.absPath, model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not reachable/i.test(msg) || /ffmpeg is required/i.test(msg)) {
      console.error(`\nABORT: ${msg}`);
      console.error(`Stopped after ${aerial} re-tagged.`);
      process.exit(1);
    }
    failed++;
    continue;
  }
  if (v.room === "aerial") {
    aerial++;
    if (apply) {
      setImageTag({
        imageId: img.imageId,
        roomType: "aerial",
        confidence: v.confidence,
        taggedBy: "migration",
        notes: keepNotes(img.imageId, `local:${model}`),
      });
    }
  } else {
    kept++;
    if (v.room !== "exterior") {
      otherVerdicts.set(v.room, (otherVerdicts.get(v.room) ?? 0) + 1);
    }
  }
  if ((i + 1) % 100 === 0) {
    const rate = (Date.now() - started) / 1000 / (i + 1);
    console.error(`  …${i + 1}/${exteriors.length} (${rate.toFixed(1)}s ea, ~${Math.round((rate * (exteriors.length - i - 1)) / 60)}min left)`);
  }
}

console.log(`\n  -> aerial: ${aerial}`);
console.log(`  kept as exterior: ${kept}   errored: ${failed}`);
if (otherVerdicts.size) {
  console.log(`  (of those kept, the model would have said something else — NOT changed:)`);
  for (const [r, n] of [...otherVerdicts].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${r}: ${n}`);
  }
}
console.log(`\n${apply ? "APPLIED." : "DRY RUN — nothing written. Re-run with --apply."}`);
