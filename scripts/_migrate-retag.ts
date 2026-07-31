import "../src/lib/load-env";
import { parseFlags } from "../src/lib/args";
import { listTaggedImages, setImageTag, isRoomType } from "../src/db/queries/tags";
import { sqlite } from "../src/db/client";
import { classifyRoom, DEFAULT_VISION_MODEL } from "../src/lib/room-classify";

/**
 * Supervised re-tagging sweep: re-examine every image currently tagged --from,
 * and re-tag the ones the model calls --to. Everything else is left alone.
 *
 * Used after a vocabulary change, when existing hand tags predate the new
 * value. OVERWRITES hand-assigned tags — copy data/app.db first. Idempotent.
 *
 *   npx tsx scripts/_migrate-retag.ts --from=other --to=exclude [--apply]
 */

const f = parseFlags(process.argv.slice(2));
const from = typeof f.from === "string" ? f.from : "";
const to = typeof f.to === "string" ? f.to : "";
const apply = f.apply === true || f.apply === "true";
const model = typeof f.model === "string" ? f.model : DEFAULT_VISION_MODEL;
const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;

if (!isRoomType(from) || !isRoomType(to) || from === to) {
  console.error("Usage: --from=<roomType> --to=<roomType> [--apply] [--limit=N] [--model=name]");
  process.exit(1);
}
if (!apply) console.error("DRY RUN — pass --apply to write.\n");

/** setImageTag nulls notes when omitted; preserve what is there. */
const existingNotes = new Map<string, string | null>(
  (
    sqlite.prepare("SELECT image_id AS id, notes FROM image_tags").all() as {
      id: string;
      notes: string | null;
    }[]
  ).map((r) => [r.id, r.notes]),
);

let targets = (listTaggedImages({}) as any[]).filter((i) => i.roomType === from);
if (limit && limit > 0) targets = targets.slice(0, limit);

console.log(`Re-examining ${targets.length} "${from}" images with ${model}; re-tagging those it calls "${to}".`);
const started = Date.now();
let changed = 0;
let kept = 0;
let failed = 0;
const wouldSay = new Map<string, number>();
const samples: string[] = [];

for (const [i, img] of targets.entries()) {
  let v;
  try {
    v = await classifyRoom(img.absPath, model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not reachable/i.test(msg) || /ffmpeg is required/i.test(msg)) {
      console.error(`\nABORT: ${msg}\nStopped after ${changed} re-tagged.`);
      process.exit(1);
    }
    failed++;
    continue;
  }
  if (v.room === to) {
    changed++;
    if (samples.length < 12) samples.push(`${img.imageId}  ${img.absPath}`);
    if (apply) {
      setImageTag({
        imageId: img.imageId,
        roomType: to,
        confidence: v.confidence,
        taggedBy: "migration",
        notes: existingNotes.get(img.imageId) || `local:${model}`,
      });
    }
  } else {
    kept++;
    if (v.room !== from) wouldSay.set(v.room, (wouldSay.get(v.room) ?? 0) + 1);
  }
  if ((i + 1) % 100 === 0) {
    const rate = (Date.now() - started) / 1000 / (i + 1);
    console.error(`  …${i + 1}/${targets.length} (${rate.toFixed(1)}s ea, ~${Math.round((rate * (targets.length - i - 1)) / 60)}min left)`);
  }
}

console.log(`\n  ${from} -> ${to}: ${changed}`);
console.log(`  kept as ${from}: ${kept}   errored: ${failed}`);
if (wouldSay.size) {
  console.log(`  (of those kept, the model would have said something else — NOT changed:)`);
  for (const [r, n] of [...wouldSay].sort((a, b) => b[1] - a[1])) console.log(`     ${r}: ${n}`);
}
if (samples.length) {
  console.log(`\n  sample of what moved to "${to}":`);
  for (const s of samples) console.log(`    ${s}`);
}
console.log(`\n${apply ? "APPLIED." : "DRY RUN — nothing written."}`);
