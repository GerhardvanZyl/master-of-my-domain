/**
 * Unit tests for the local-model transport and the room-classification gate.
 * No server, no DB, no network: fetch is stubbed.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askLocal } from "../src/lib/local-llm";

// A tiny real file on disk so the base64 path is exercised for real.
const tmpImg = path.join(os.tmpdir(), "local-llm-test.png");
fs.writeFileSync(tmpImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]));

const realFetch = globalThis.fetch;
let lastUrl = "";
let lastBody: any = null;
let lastInit: any = null;

function stubFetch(reply: unknown, ok = true, status = 200) {
  globalThis.fetch = (async (url: string, init: any) => {
    lastUrl = String(url);
    lastInit = init;
    lastBody = JSON.parse(init.body);
    return {
      ok,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const okReply = {
  choices: [{ message: { content: '{"room":"kitchen","confidence":0.91}' } }],
};

const SCHEMA = {
  type: "object",
  properties: { room: { type: "string" }, confidence: { type: "number" } },
  required: ["room", "confidence"],
  additionalProperties: false,
};

// --- askLocal: request shape ---
stubFetch(okReply);
const parsed = await askLocal({
  model: "test-model",
  prompt: "classify this",
  imagePath: tmpImg,
  schema: SCHEMA,
  schemaName: "room_verdict",
  baseUrl: "http://127.0.0.1:9999/v1",
});
assert.deepEqual(parsed, { room: "kitchen", confidence: 0.91 }, "returns parsed JSON");
assert.equal(lastUrl, "http://127.0.0.1:9999/v1/chat/completions", "posts to chat/completions");
assert.equal(lastInit.method, "POST", "posts, not gets");
assert.equal(lastInit.headers["content-type"], "application/json", "sends JSON content-type");
assert.ok(lastInit.signal instanceof AbortSignal, "wires an AbortSignal for the request timeout");
assert.equal(lastBody.model, "test-model");
assert.equal(lastBody.temperature, 0, "deterministic: temperature 0");
assert.equal(
  lastBody.response_format.type,
  "json_schema",
  "constrains the reply with a schema instead of hoping",
);
assert.equal(lastBody.response_format.json_schema.name, "room_verdict");
assert.equal(lastBody.response_format.json_schema.strict, true);
assert.deepEqual(
  lastBody.response_format.json_schema.schema,
  SCHEMA,
  "the exact schema payload is sent, not mangled or dropped",
);

const parts = lastBody.messages.at(-1).content;
assert.equal(parts[0].type, "text");
assert.equal(parts[0].text, "classify this");
assert.equal(parts[1].type, "image_url", "image is sent as an image_url part");
assert.ok(
  parts[1].image_url.url.startsWith("data:image/png;base64,"),
  "png extension maps to the png mime type",
);
const b64 = parts[1].image_url.url.slice("data:image/png;base64,".length);
assert.deepEqual(
  Buffer.from(b64, "base64"),
  fs.readFileSync(tmpImg),
  "the image's exact bytes are encoded, not truncated",
);

// --- askLocal: no image means no image part ---
stubFetch(okReply);
await askLocal({ model: "m", prompt: "p", schema: SCHEMA, baseUrl: "http://x/v1" });
assert.equal(lastBody.messages.at(-1).content.length, 1, "text-only call has one content part");
assert.equal(lastBody.messages.length, 1, "no system message when none is given");

// --- askLocal: system prompt is prepended ---
stubFetch(okReply);
await askLocal({ model: "m", prompt: "p", system: "s", schema: SCHEMA, baseUrl: "http://x/v1" });
assert.equal(lastBody.messages.length, 2);
assert.equal(lastBody.messages[0].role, "system");
assert.equal(lastBody.messages[0].content, "s");

// --- askLocal: connection failure names the URL and the fix ---
globalThis.fetch = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;
await assert.rejects(
  askLocal({ model: "m", prompt: "p", schema: SCHEMA, baseUrl: "http://127.0.0.1:9/v1" }),
  (e: Error) => {
    assert.match(e.message, /not reachable/i, "says the server is unreachable");
    assert.match(e.message, /127\.0\.0\.1:9/, "names the URL it tried");
    assert.match(e.message, /LM Studio/, "says how to fix it");
    return true;
  },
  "a down server produces one clear error",
);

// --- askLocal: a timeout is distinguishable from a down server (C1) ---
// AbortSignal.timeout() rejects with a DOMException named "TimeoutError" —
// tag-bench must be able to skip just this photo instead of aborting the
// whole run, so the message must not match the /not reachable/i abort regex.
globalThis.fetch = (async () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
}) as unknown as typeof fetch;
await assert.rejects(
  askLocal({ model: "m", prompt: "p", schema: SCHEMA, baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 5 }),
  (e: Error) => {
    assert.match(e.message, /timed out/i, "says the call timed out");
    assert.doesNotMatch(
      e.message,
      /not reachable/i,
      "a timeout is distinguishable from a down server",
    );
    assert.doesNotMatch(
      e.message,
      /Could not read image/,
      "a timeout is distinguishable from an unreadable image",
    );
    return true;
  },
  "a slow call times out with a skip-this-photo message, not an abort message",
);

// --- askLocal: HTTP error surfaces the status ---
stubFetch({ error: "model not loaded" }, false, 404);
await assert.rejects(
  askLocal({ model: "m", prompt: "p", schema: SCHEMA, baseUrl: "http://x/v1" }),
  /404/,
  "non-2xx includes the status code",
);

// --- askLocal: a non-JSON reply is an error, not a silent undefined ---
stubFetch({ choices: [{ message: { content: "I think it's a kitchen!" } }] });
await assert.rejects(
  askLocal({ model: "m", prompt: "p", schema: SCHEMA, baseUrl: "http://x/v1" }),
  /not JSON/,
  "prose replies fail loudly",
);

// --- askLocal: an empty reply is an error ---
stubFetch({ choices: [] });
await assert.rejects(
  askLocal({ model: "m", prompt: "p", schema: SCHEMA, baseUrl: "http://x/v1" }),
  /no message content/,
);

// --- askLocal: a missing image file names the path, not "the server is down" ---
// Distinguishable from the unreachable-server error: Task 5/7 skip the photo on
// this one but abort the whole run on a down server, matching on /not reachable/i.
stubFetch(okReply);
const missingImg = path.join(os.tmpdir(), "local-llm-test-missing.png");
await assert.rejects(
  askLocal({
    model: "m",
    prompt: "p",
    imagePath: missingImg,
    schema: SCHEMA,
    baseUrl: "http://x/v1",
  }),
  (e: Error) => {
    assert.ok(e.message.includes(missingImg), "names the file that could not be read");
    assert.doesNotMatch(
      e.message,
      /not reachable/i,
      "a bad photo is distinguishable from a down server",
    );
    return true;
  },
  "an unreadable image fails with an actionable, distinguishable message",
);

// ---------------------------------------------------------------------------
// room-classify: prompt, verdict validation, gate
// ---------------------------------------------------------------------------
import { ROOM_TYPES } from "../src/db/schema";
import {
  ROOM_PROMPT,
  ROOM_SCHEMA,
  parseRoomVerdict,
  passesGate,
  classifyRoom,
} from "../src/lib/room-classify";

// --- the schema pins the vocabulary to the DB's own list ---
assert.deepEqual(
  (ROOM_SCHEMA as any).properties.room.enum,
  [...ROOM_TYPES],
  "schema enum is ROOM_TYPES, not a hand-copied list",
);
assert.equal((ROOM_SCHEMA as any).additionalProperties, false);
assert.deepEqual((ROOM_SCHEMA as any).required, ["room", "confidence"]);

// --- the prompt names every room type and the tie-breaker rules ---
for (const r of ROOM_TYPES) {
  assert.ok(ROOM_PROMPT.includes(r), `prompt mentions "${r}"`);
}
assert.match(ROOM_PROMPT, /open-plan/i, "prompt resolves the open-plan case");
assert.match(ROOM_PROMPT, /floorplan/i, "prompt sends floorplans to other");

// --- parseRoomVerdict: happy path ---
assert.deepEqual(parseRoomVerdict({ room: "kitchen", confidence: 0.9 }), {
  room: "kitchen",
  confidence: 0.9,
});
assert.deepEqual(parseRoomVerdict({ room: "other", confidence: 0 }), {
  room: "other",
  confidence: 0,
});

// --- parseRoomVerdict: rejects anything outside the vocabulary ---
assert.throws(() => parseRoomVerdict({ room: "laundry", confidence: 0.9 }), /invalid room/i);
assert.throws(() => parseRoomVerdict({ room: "Kitchen", confidence: 0.9 }), /invalid room/i);
assert.throws(() => parseRoomVerdict({ confidence: 0.9 }), /invalid room/i);
assert.throws(() => parseRoomVerdict(null), /invalid room/i);

// --- parseRoomVerdict: rejects unusable confidence ---
assert.throws(() => parseRoomVerdict({ room: "kitchen", confidence: 1.5 }), /invalid confidence/i);
assert.throws(() => parseRoomVerdict({ room: "kitchen", confidence: -0.1 }), /invalid confidence/i);
assert.throws(() => parseRoomVerdict({ room: "kitchen", confidence: "high" }), /invalid confidence/i);
assert.throws(() => parseRoomVerdict({ room: "kitchen" }), /invalid confidence/i);

// --- passesGate: the boundary is inclusive, and that is deliberate ---
assert.equal(passesGate({ room: "kitchen", confidence: 0.9 }, 0.9), true, "at threshold writes");
assert.equal(passesGate({ room: "kitchen", confidence: 0.8999 }, 0.9), false, "just below queues");
assert.equal(passesGate({ room: "kitchen", confidence: 1 }, 0.9), true);
assert.equal(passesGate({ room: "kitchen", confidence: 0 }, 0), true, "threshold 0 writes everything");
assert.equal(passesGate({ room: "kitchen", confidence: 0.99 }, 1), false, "threshold 1 needs certainty");

// --- classifyRoom: sends the image and the shared prompt, returns a verdict ---
stubFetch({ choices: [{ message: { content: '{"room":"dining","confidence":0.72}' } }] });
const verdict = await classifyRoom(tmpImg, "vision-model-x");
assert.deepEqual(verdict, { room: "dining", confidence: 0.72 });
assert.equal(lastBody.model, "vision-model-x", "model override is honoured");
assert.equal(
  lastBody.messages.at(-1).content[0].text,
  ROOM_PROMPT,
  "classifyRoom ships the shared prompt verbatim — the benchmark must measure what runs",
);
assert.equal(lastBody.messages.at(-1).content[1].type, "image_url", "the photo is attached");

// --- classifyRoom: a model that ignores the schema still fails loudly ---
stubFetch({ choices: [{ message: { content: '{"room":"garage","confidence":0.9}' } }] });
await assert.rejects(classifyRoom(tmpImg, "m"), /invalid room/i);

// --- tag:auto refuses to run without a threshold ---
import { execFileSync } from "node:child_process";

function runTagAuto(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/tag-auto.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // shell: true is required on Windows — execFileSync cannot exec npx.cmd
      // directly (ENOENT), since it isn't a real PE executable.
      shell: true,
    });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

for (const bad of [[], ["--threshold=abc"], ["--threshold=1.5"], ["--threshold=-1"]]) {
  const r = runTagAuto(bad);
  assert.notEqual(r.status, 0, `tag:auto must reject ${JSON.stringify(bad)}`);
  assert.match(r.out, /threshold/i, "the error explains the threshold");
  assert.match(r.out, /tag:bench/, "the error points at the benchmark");
}

globalThis.fetch = realFetch;
fs.unlinkSync(tmpImg);

// ---------------------------------------------------------------------------
// bench-report: pure arithmetic seam for tag:bench (I4) — this is the only
// insurance the report's numbers ever get, so it is not a smoke test.
// ---------------------------------------------------------------------------
import { pct, renderReport, type BenchRow } from "../src/lib/bench-report";

// --- pct: division by zero is "n/a", never a NaN% ---
assert.equal(pct(0, 0), "n/a", "0/0 must not render as NaN%");
assert.equal(pct(3, 4), "75.0% (3/4)");

// --- 12 hand-computed rows. Every value below (buckets, threshold-0.85 auto
// count, confusion off-diagonal, precision/recall, overall agreement) is
// hand-derived from this exact fixture and pinned — mutation-tested against
// deliberately broken copies of bench-report.ts. See task-5-report.md for
// the arithmetic and the list of mutations each pin catches.
//
// truth      got        confidence  correct?
// kitchen    kitchen    0.97        yes
// kitchen    kitchen    0.92        yes
// kitchen    living     0.60        no
// kitchen    bathroom   0.85        no   <- sits exactly on the 0.85 boundary
// bedroom    bedroom    0.99        yes
// bedroom    bathroom   0.55        no
// bathroom   bathroom   0.91        yes
// living     bedroom    0.75        no
// living     living     0.83        yes
// exterior   exterior   0.96        yes
// exterior   exterior   1.00        yes  <- exercises the 1.01 sentinel
// dining     dining     0.90        yes  <- sits exactly in the [0.90,0.91) gap
const benchRows: BenchRow[] = [
  { imageId: "1", truth: "kitchen", got: "kitchen", confidence: 0.97 },
  { imageId: "2", truth: "kitchen", got: "kitchen", confidence: 0.92 },
  { imageId: "3", truth: "kitchen", got: "living", confidence: 0.6 },
  { imageId: "4", truth: "kitchen", got: "bathroom", confidence: 0.85 },
  { imageId: "5", truth: "bedroom", got: "bedroom", confidence: 0.99 },
  { imageId: "6", truth: "bedroom", got: "bathroom", confidence: 0.55 },
  { imageId: "7", truth: "bathroom", got: "bathroom", confidence: 0.91 },
  { imageId: "8", truth: "living", got: "bedroom", confidence: 0.75 },
  { imageId: "9", truth: "living", got: "living", confidence: 0.83 },
  { imageId: "10", truth: "exterior", got: "exterior", confidence: 0.96 },
  { imageId: "11", truth: "exterior", got: "exterior", confidence: 1.0 },
  { imageId: "12", truth: "dining", got: "dining", confidence: 0.9 },
];

const report = renderReport(benchRows, 0, {
  model: "test-vlm",
  elapsedMs: 60_000,
  outPath: "/tmp/_tagbench.jsonl",
  propertyCount: 4,
  photoCount: 12,
  timestamp: "2026-07-30T00:00:00.000Z",
});

// --- precision != recall for kitchen, both hand-computed values pinned ---
// kitchen actual (truth=kitchen) = rows 1,2,3,4 = 4.
// kitchen predicted (got=kitchen) = rows 1,2 = 2 (row 3 got "living", row 4 got "bathroom").
// tp = rows 1,2 = 2. precision = 2/2 = 100.0%, recall = 2/4 = 50.0%.
const kitchenLine = report
  .split("\n")
  .find((l) => l.trim().startsWith("kitchen") && l.includes("precision"));
assert.ok(kitchenLine, "report has a per-room line for kitchen");
assert.match(kitchenLine!, /precision 100\.0% \(2\/2\)/, "kitchen precision pinned at 2/2");
assert.match(kitchenLine!, /recall 50\.0% \(2\/4\)/, "kitchen recall pinned at 2/4");
assert.notEqual(
  kitchenLine!.match(/precision ([\d.]+)%/)![1],
  kitchenLine!.match(/recall ([\d.]+)%/)![1],
  "precision and recall genuinely differ for kitchen, not accidentally equal",
);

// --- confusion matrix: pin an off-diagonal cell (catches transposition) ---
// A diagonal cell can't distinguish "row=truth,col=got" from its transpose,
// since diag[i][i] is the same either way. Off-diagonal breaks the tie: row 4
// is the only kitchen-truth photo the model called "bathroom", so the cell at
// (truth=kitchen, got=bathroom) must read exactly 1. Under transposition this
// cell would instead show (truth=bathroom, got=kitchen), which is 0 in this
// fixture (bathroom's only row, #7, was correctly called bathroom) — so a
// transposed matrix fails this assertion.
const confusionKitchenLine = report
  .split("\n")
  .find((l) => l.startsWith("kitchen")); // truth rows have no leading whitespace; the precision line does
assert.ok(confusionKitchenLine, "report has a confusion-matrix row for kitchen");
// Column order follows ROOM_TYPES: kitchen, bathroom, bedroom, living, dining, exterior, other, total.
const confusionNums = confusionKitchenLine!.match(/\d+/g)!.map(Number);
assert.equal(confusionNums[0], 2, "confusion[kitchen][kitchen] = 2 (rows 1,2)");
assert.equal(
  confusionNums[1],
  1,
  "confusion[kitchen][bathroom] = 1 (row 4) — off-diagonal, distinguishes orientation from its transpose",
);
assert.equal(confusionNums.at(-1), 4, "kitchen truth row total = 4");

// --- confidence buckets: pin every bucket's exact count, not just the sum ---
// 0.95+        : rows 1(0.97),5(0.99),10(0.96),11(1.00)         = 4  (row 11 exercises the 1.01 sentinel)
// 0.90–<0.95   : rows 2(0.92),7(0.91),12(0.90)                  = 3  (row 12 sits exactly in the [0.90,0.91) gap)
// 0.80–<0.90   : rows 4(0.85),9(0.83)                           = 2  (row 4 sits exactly on the 0.85 threshold boundary)
// 0.70–<0.80   : row 8(0.75)                                    = 1
// <0.70        : rows 3(0.60),6(0.55)                           = 2
const bucketNs = [...report.matchAll(/conf \S+\s+n=\s*(\d+)/g)].map((m) => Number(m[1]));
assert.deepEqual(
  bucketNs,
  [4, 3, 2, 1, 2],
  "every confidence bucket count is pinned exactly — catches the 1.01 sentinel, narrow boundary shifts, and mis-bucketing",
);
assert.equal(
  bucketNs.reduce((a, b) => a + b, 0),
  benchRows.length,
  "bucket counts also sum to rows.length",
);

// --- overall agreement percentage, pinned ---
// 8 of 12 rows correct: rows 1,2,5,7,9,10,11,12. Rows 3,4,6,8 are wrong.
assert.match(
  report,
  /Overall agreement with your tags: 66\.7% \(8\/12\)/,
  "overall agreement is pinned, not just present",
);

// --- threshold table: pin the exact auto-tag count at t=0.85 (catches >= vs >) ---
// auto+queued===rows.length is invariant under a >= -> > flip (both sides
// shift by 1 together), so that invariant alone can never catch a boundary
// bug. Row 4 sits exactly at confidence 0.85, so pinning the auto count here
// is the one assertion that distinguishes ">= 0.85" from "> 0.85".
// auto (confidence >= 0.85) = rows 1,2,4,5,7,10,11,12 = 8.
// Of those, row 4 (kitchen->bathroom) is wrong -> wrong=1, error rate 1/8=12.5%.
const t085Line = report.split("\n").find((l) => l.includes("--threshold=0.85"));
assert.ok(t085Line, "report has a threshold=0.85 line");
assert.match(
  t085Line!,
  /auto-tags 66\.7% \(8\/12\)/,
  "auto count at t=0.85 pinned exactly at 8 — a >= vs > flip on row 4 (confidence exactly 0.85) would change this to 7",
);
assert.match(
  t085Line!,
  /1 of those wrong \(12\.5% error rate\)/,
  "wrong count and its M5 error rate are pinned at a threshold where wrong is non-zero",
);
assert.match(t085Line!, /4 queued for review/, "queued count at t=0.85 pinned at 4");

// --- at every threshold, auto-tagged + queued-for-review === rows.length ---
// (Necessary but not sufficient on its own — see the t=0.85 pin above for
// the assertion that actually catches a >= vs > boundary flip.)
const thresholdLines = [...report.matchAll(
  /auto-tags [\d.]+% \((\d+)\/\d+\).*?(\d+) queued for review/g,
)];
assert.equal(thresholdLines.length, 5, "one line per threshold (0.70..0.95)");
for (const [, autoStr, queuedStr] of thresholdLines) {
  assert.equal(
    Number(autoStr) + Number(queuedStr),
    benchRows.length,
    "auto-tagged + queued must account for every row at each threshold",
  );
}

console.log("✓ local-llm.test: all assertions passed");
