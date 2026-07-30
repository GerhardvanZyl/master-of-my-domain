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

function stubFetch(reply: unknown, ok = true, status = 200) {
  globalThis.fetch = (async (url: string, init: any) => {
    lastUrl = String(url);
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
assert.equal(lastBody.model, "test-model");
assert.equal(lastBody.temperature, 0, "deterministic: temperature 0");
assert.equal(
  lastBody.response_format.type,
  "json_schema",
  "constrains the reply with a schema instead of hoping",
);
assert.equal(lastBody.response_format.json_schema.name, "room_verdict");
assert.equal(lastBody.response_format.json_schema.strict, true);

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

globalThis.fetch = realFetch;
fs.unlinkSync(tmpImg);

console.log("✓ local-llm.test: all assertions passed");
