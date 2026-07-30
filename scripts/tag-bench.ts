import "../src/lib/load-env";
import fs from "node:fs";
import path from "node:path";
import { parseFlags } from "../src/lib/args";
import { listTaggedImages, topTaggedProperties } from "../src/db/queries/tags";
import { ROOM_TYPES, type RoomType } from "../src/db/schema";
import { classifyRoom, DEFAULT_VISION_MODEL } from "../src/lib/room-classify";
import { DATA_DIR } from "../src/lib/env";

/**
 * Measures a local vision model against the room tags already in the DB.
 * READ-ONLY: this file must never import a write helper. Its whole job is to
 * tell you which --threshold to give tag:auto.
 */

const f = parseFlags(process.argv.slice(2));
const model = typeof f.model === "string" ? f.model : DEFAULT_VISION_MODEL;
const count = typeof f.count === "string" ? Number(f.count) : 10;
const limit = typeof f.limit === "string" ? Number(f.limit) : undefined;
const ids =
  typeof f.properties === "string"
    ? f.properties.split(",").map((s) => s.trim()).filter(Boolean)
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
interface Row {
  imageId: string;
  truth: RoomType;
  got: RoomType;
  confidence: number;
}
const results: Row[] = [];
let failed = 0;
const started = Date.now();

for (const [i, img] of images.entries()) {
  try {
    const v = await classifyRoom(img.absPath, model);
    results.push({
      imageId: img.imageId,
      truth: img.roomType,
      got: v.room,
      confidence: v.confidence,
    });
    fs.appendFileSync(
      outPath,
      JSON.stringify({
        model,
        imageId: img.imageId,
        truth: img.roomType,
        ...v,
      }) + "\n",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A dead server is not a per-image problem — stop instead of printing 270 copies.
    if (/not reachable/i.test(msg)) {
      console.error(msg);
      process.exit(1);
    }
    failed++;
    console.error(`  ! ${img.imageId}: ${msg}`);
    if (failed >= 5 && results.length === 0) {
      console.error(
        "Aborting: the first 5 calls all failed. Is the loaded model vision-capable?",
      );
      process.exit(1);
    }
  }
  if ((i + 1) % 25 === 0) {
    const rate = (Date.now() - started) / 1000 / (i + 1);
    console.error(
      `  …${i + 1}/${images.length} (${rate.toFixed(1)}s/photo, ~${Math.round((rate * (images.length - i - 1)) / 60)}min left)`,
    );
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

const agreed = results.filter((r) => r.truth === r.got).length;
const W = 10;

console.log(`\nModel:  ${model}`);
console.log(`Photos: ${results.length} classified, ${failed} errored`);
console.log(`Time:   ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
console.log(`Overall agreement with your tags: ${pct(agreed, results.length)}`);

console.log("\nConfusion — row = your tag, column = model's tag");
console.log(
  "".padEnd(W) +
    ROOM_TYPES.map((r) => r.slice(0, 8).padStart(W)).join("") +
    "total".padStart(W),
);
for (const truth of ROOM_TYPES) {
  const row = results.filter((r) => r.truth === truth);
  console.log(
    truth.padEnd(W) +
      ROOM_TYPES.map((got) =>
        String(row.filter((r) => r.got === got).length).padStart(W),
      ).join("") +
      String(row.length).padStart(W),
  );
}

console.log("\nPer-room precision / recall");
for (const room of ROOM_TYPES) {
  const tp = results.filter((r) => r.truth === room && r.got === room).length;
  const predicted = results.filter((r) => r.got === room).length;
  const actual = results.filter((r) => r.truth === room).length;
  console.log(
    `  ${room.padEnd(9)} precision ${pct(tp, predicted).padEnd(18)} recall ${pct(tp, actual)}`,
  );
}

console.log("\nAgreement by the model's own confidence");
const buckets: [number, number][] = [
  [0.95, 1.01],
  [0.9, 0.95],
  [0.8, 0.9],
  [0.7, 0.8],
  [0, 0.7],
];
for (const [lo, hi] of buckets) {
  const b = results.filter((r) => r.confidence >= lo && r.confidence < hi);
  if (b.length === 0) continue;
  const ok = b.filter((r) => r.truth === r.got).length;
  const label = `${lo.toFixed(2)}–${hi > 1 ? "1.00" : hi.toFixed(2)}`;
  console.log(`  conf ${label}  n=${String(b.length).padStart(4)}  agreement ${pct(ok, b.length)}`);
}

console.log("\nWhat tag:auto would have done at each threshold");
for (const t of [0.7, 0.8, 0.85, 0.9, 0.95]) {
  const auto = results.filter((r) => r.confidence >= t);
  const ok = auto.filter((r) => r.truth === r.got).length;
  const wrong = auto.length - ok;
  console.log(
    `  --threshold=${t.toFixed(2)}  auto-tags ${pct(auto.length, results.length)}` +
      `, ${wrong} of those wrong, ${results.length - auto.length} queued for review`,
  );
}
console.log(`\nRaw rows appended to ${outPath}`);
