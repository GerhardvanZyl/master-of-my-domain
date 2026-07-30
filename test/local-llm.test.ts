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

// --- 10 hand-computed rows, chosen so kitchen's precision and recall differ ---
// kitchen truth: rows 1,2,3,4 (actual=4). kitchen got: rows 1,2,4 (predicted=3,
// row 3 was misclassified as "living"). tp = rows 1,2,4 = 3.
// precision = 3/3 = 100.0%, recall = 3/4 = 75.0% — pinned below.
const benchRows: BenchRow[] = [
  { imageId: "1", truth: "kitchen", got: "kitchen", confidence: 0.97 },
  { imageId: "2", truth: "kitchen", got: "kitchen", confidence: 0.92 },
  { imageId: "3", truth: "kitchen", got: "living", confidence: 0.6 },
  { imageId: "4", truth: "kitchen", got: "kitchen", confidence: 0.85 },
  { imageId: "5", truth: "bedroom", got: "bedroom", confidence: 0.99 },
  { imageId: "6", truth: "bedroom", got: "bathroom", confidence: 0.55 },
  { imageId: "7", truth: "bathroom", got: "bathroom", confidence: 0.91 },
  { imageId: "8", truth: "living", got: "bedroom", confidence: 0.75 },
  { imageId: "9", truth: "living", got: "living", confidence: 0.83 },
  { imageId: "10", truth: "exterior", got: "exterior", confidence: 0.96 },
];

const report = renderReport(benchRows, 0, {
  model: "test-vlm",
  elapsedMs: 60_000,
  outPath: "/tmp/_tagbench.jsonl",
  propertyCount: 3,
  photoCount: 10,
  timestamp: "2026-07-30T00:00:00.000Z",
});

// --- precision != recall for kitchen, both hand-computed values pinned ---
const kitchenLine = report
  .split("\n")
  .find((l) => l.trim().startsWith("kitchen") && l.includes("precision"));
assert.ok(kitchenLine, "report has a per-room line for kitchen");
assert.match(kitchenLine!, /precision 100\.0% \(3\/3\)/, "kitchen precision pinned at 3/3");
assert.match(kitchenLine!, /recall 75\.0% \(3\/4\)/, "kitchen recall pinned at 3/4");
assert.notEqual(
  kitchenLine!.match(/precision ([\d.]+)%/)![1],
  kitchenLine!.match(/recall ([\d.]+)%/)![1],
  "precision and recall genuinely differ for kitchen, not accidentally equal",
);

// --- confidence bucket counts sum to rows.length ---
const bucketNs = [...report.matchAll(/conf \S+\s+n=\s*(\d+)/g)].map((m) => Number(m[1]));
assert.ok(bucketNs.length > 0, "at least one confidence bucket line rendered");
assert.equal(
  bucketNs.reduce((a, b) => a + b, 0),
  benchRows.length,
  "every row lands in exactly one confidence bucket",
);

// --- at every threshold, auto-tagged + queued-for-review === rows.length ---
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
