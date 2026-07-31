/**
 * Unit tests for the local-model transport and the room-classification gate.
 * No server, no DB, no network: fetch is stubbed.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askLocal } from "../src/lib/local-llm";

// A tiny real, ffmpeg-decodable PNG on disk so the base64 path is exercised
// for real, and so classifyRoom() (which now always runs images through
// image-prep.ts's ffmpeg conversion) can actually convert it.
const tmpImg = path.join(os.tmpdir(), "local-llm-test.png");
fs.writeFileSync(
  tmpImg,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjHwMDAwgAGAAsiAQRmV5cZAAAAAElFTkSuQmCC",
    "base64",
  ),
);

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
  source: "model",
});
assert.deepEqual(parseRoomVerdict({ room: "other", confidence: 0 }), {
  room: "other",
  confidence: 0,
  source: "model",
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
assert.equal(
  passesGate({ room: "kitchen", confidence: 0.9, source: "model" }, 0.9),
  true,
  "at threshold writes",
);
assert.equal(
  passesGate({ room: "kitchen", confidence: 0.8999, source: "model" }, 0.9),
  false,
  "just below queues",
);
assert.equal(passesGate({ room: "kitchen", confidence: 1, source: "model" }, 0.9), true);
assert.equal(
  passesGate({ room: "kitchen", confidence: 0, source: "model" }, 0),
  true,
  "threshold 0 writes everything",
);
assert.equal(
  passesGate({ room: "kitchen", confidence: 0.99, source: "model" }, 1),
  false,
  "threshold 1 needs certainty",
);

// --- classifyRoom: sends the image and the shared prompt, returns a verdict ---
stubFetch({ choices: [{ message: { content: '{"room":"dining","confidence":0.72}' } }] });
const verdict = await classifyRoom(tmpImg, "vision-model-x");
assert.deepEqual(verdict, { room: "dining", confidence: 0.72, source: "model" });
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
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { DDL, migrateColumns } from "../src/db/ddl";

// This file is ESM; the TOCTOU race test below needs require.resolve() to
// find better-sqlite3's real installed path so a preload script written to
// an OS temp dir (outside node_modules' resolution reach) can still import it.
const require = createRequire(import.meta.url);

// process.execPath + tsx's own CLI entry point avoids both the Windows
// npx.cmd ENOENT problem (execFileSync can't exec a .cmd shim directly) and
// running the child through a shell at all.
const TSX_BIN = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const TAG_AUTO = path.join(process.cwd(), "scripts", "tag-auto.ts");

// A throwaway DB_PATH for every subprocess this file spawns — never
// data/app.db. Individual tests below override it with their own sandbox.
const defaultGuardDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-tagauto-guard-"));
const DEFAULT_ENV = {
  DATA_DIR: defaultGuardDir,
  DB_PATH: path.join(defaultGuardDir, "app.db"),
  IMAGES_DIR: path.join(defaultGuardDir, "images"),
};

function runTagAuto(
  args: string[],
  envOverrides: Record<string, string> = DEFAULT_ENV,
): { status: number; out: string; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TSX_BIN, TAG_AUTO, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
  const status = res.status ?? (res.error ? 1 : 0);
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  // `out` (concatenated) is kept for the many existing assertions that don't
  // care which stream a message landed on. F5: new tests that DO care about
  // stream separation (the review queue must be pure JSON on stdout, with
  // progress/errors on stderr) use `stdout`/`stderr` directly instead.
  return { status, out: `${stdout}${stderr}`, stdout, stderr };
}

// Each case pins a CRITICAL 1 reproducer: deleting the trim/empty-string
// guard in src/lib/args.ts, or the >0 check for --limit, would make one of
// these silently pass instead of failing loudly.
const BAD_INVOCATIONS: { args: string[]; mustAlsoMatch?: RegExp }[] = [
  { args: [] },
  { args: ["--threshold=abc"] },
  { args: ["--threshold=1.5"] },
  { args: ["--threshold=-1"] },
  { args: ["--threshold="] }, // Number("") === 0 must not slip through as a legitimate zero
  { args: ["--threshold=0.9", "--limit=abc"], mustAlsoMatch: /limit/i },
  { args: ["--threshold=0.9", "--limit=0"], mustAlsoMatch: /limit/i }, // must not silently disable the LIMIT clause
];

for (const { args, mustAlsoMatch } of BAD_INVOCATIONS) {
  const r = runTagAuto(args);
  assert.notEqual(r.status, 0, `tag:auto must reject ${JSON.stringify(args)}`);
  assert.match(r.out, /threshold/i, "the error explains the threshold");
  assert.match(r.out, /tag:bench/, "the error points at the benchmark");
  if (mustAlsoMatch) {
    assert.match(r.out, mustAlsoMatch, `error for ${JSON.stringify(args)} names the actual bad flag`);
  }
}

// --- --dry-run's truthy set and the unknown-flag allowlist (subprocess-only, no DB needed) ---
{
  const r1 = runTagAuto(["--threshold=0.9", "--dry-run=1"]);
  assert.equal(r1.status, 0, `--dry-run=1 must be accepted, got: ${r1.out}`);

  const r2 = runTagAuto(["--threshold=0.9", "--dry-run=nonsense"]);
  assert.notEqual(r2.status, 0, "--dry-run=nonsense must be rejected");
  assert.match(r2.out, /dry-run/i, "the error explains the bad --dry-run value");

  const r3 = runTagAuto(["--threshold=0.9", "--dryrun"]);
  assert.notEqual(r3.status, 0, "a misspelled --dryrun must be rejected, not silently ignored");
  assert.match(r3.out, /Unknown flag/i, "the error names the unrecognised flag");
}

fs.rmSync(defaultGuardDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// tag:auto integration: write path, dry-run, and threshold boundaries.
// Never touches data/app.db — each test builds its own isolated sandbox DB
// (same DDL tag-auto reads), a couple of untagged images with real tiny PNG
// bytes on disk, and an in-process fetch stub standing in for LM Studio
// (see fetchStubPreloadUrl below for why this isn't a node:http server).
// ---------------------------------------------------------------------------

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjHwMDAwgAGAAsiAQRmV5cZAAAAAElFTkSuQmCC",
  "base64",
);

function makeSandbox(nImages: number): {
  dir: string;
  dbPath: string;
  env: Record<string, string>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-tagauto-sandbox-"));
  const imagesDir = path.join(dir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const dbPath = path.join(dir, "app.db");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  migrateColumns(db);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO properties (id, source_site, listing_url, address, scraped_at, created_at, updated_at)
     VALUES ('prop1', 'domain', 'https://example.com/sandbox', '1 Sandbox St', ?, ?, ?)`,
  ).run(now, now, now);

  for (let i = 0; i < nImages; i++) {
    const localPath = `images/photo${i}.png`;
    fs.writeFileSync(path.join(dir, localPath), TINY_PNG);
    db.prepare(
      `INSERT INTO images (id, property_id, source_url, local_path, ordinal, created_at)
       VALUES (?, 'prop1', ?, ?, ?, ?)`,
    ).run(`img${i}`, `https://example.com/img${i}.png`, localPath, i, now);
  }
  db.close();

  return {
    dir,
    dbPath,
    env: { DATA_DIR: dir, DB_PATH: dbPath, IMAGES_DIR: imagesDir },
  };
}

/**
 * Stand in for LM Studio without a real network round trip. A real
 * node:http server hosted in this test process would not work here: these
 * tests use spawnSync, which blocks this process's event loop for the
 * child's entire lifetime, so this process can never accept() an incoming
 * connection while the child is running — the child's request would sit
 * unaccepted until it times out, regardless of network reachability. (Not
 * a sandbox/network limitation — spawn() + await against the same server
 * and child script works fine; spawnSync specifically cannot.) So instead
 * of a real socket, a `--import` preload module patches `globalThis.fetch`
 * inside the CHILD's own process, before tag-auto.ts's top-level code
 * runs — no network I/O at all, same effect as the `stubFetch()` used
 * earlier in this file, just applied to a subprocess.
 */
function fetchStubPreloadUrl(dir: string, verdict: { room: string; confidence: number }): string {
  const p = path.join(dir, "stub-fetch-preload.mjs");
  fs.writeFileSync(
    p,
    `globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => (${JSON.stringify({
    choices: [{ message: { content: JSON.stringify(verdict) } }],
  })}),
  text: async () => "",
});
`,
  );
  return pathToFileURL(p).href;
}

// --- F6: guards against load-env.ts's process.loadEnvFile silently
// retargeting DB_PATH: confirms the child process actually resolves DB_PATH
// to the sandbox path this test set, not whatever (if anything) .env.local
// says. This MUST run before any test below that writes through a sandbox
// DB — if this assumption is ever wrong, those tests would otherwise write
// to the real tracked data/app.db before this guard could report it. ---
{
  const sandbox = makeSandbox(0);
  const envTsUrl = pathToFileURL(path.join(process.cwd(), "src/lib/env.ts")).href;
  const loadEnvTsUrl = pathToFileURL(path.join(process.cwd(), "src/lib/load-env.ts")).href;
  const probePath = path.join(sandbox.dir, "probe-db-path.mjs");
  fs.writeFileSync(
    probePath,
    `import ${JSON.stringify(loadEnvTsUrl)};
import { DB_PATH } from ${JSON.stringify(envTsUrl)};
process.stdout.write(DB_PATH);
`,
  );
  const res = spawnSync(process.execPath, [TSX_BIN, probePath], {
    encoding: "utf8",
    env: { ...process.env, ...sandbox.env },
  });
  assert.equal(res.status, 0, `DB_PATH probe exits 0, got: ${res.stderr}`);
  assert.equal(
    res.stdout,
    sandbox.dbPath,
    "the sandbox DB_PATH this test set must not be overridden by load-env's process.loadEnvFile",
  );
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

// --- (a) --dry-run classifies and reports but writes zero rows ---
{
  const sandbox = makeSandbox(2);
  const preload = fetchStubPreloadUrl(sandbox.dir, { room: "kitchen", confidence: 0.95 });
  const r = runTagAuto(["--threshold=0.5", "--dry-run", "--model=test-vlm"], {
    ...sandbox.env,
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(r.status, 0, `dry-run exits 0, got: ${r.out}`);
  assert.match(r.out, /would tag 2/, "dry-run reports what it would have tagged");
  const check = new Database(sandbox.dbPath, { readonly: true });
  const taggedCount = (
    check.prepare("SELECT COUNT(*) c FROM image_tags").get() as { c: number }
  ).c;
  check.close();
  assert.equal(taggedCount, 0, "--dry-run must write zero rows to the DB");
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

// --- (b) a real write sets tagged_by='local-vlm' and notes='local:<model>' ---
{
  const sandbox = makeSandbox(1);
  const preload = fetchStubPreloadUrl(sandbox.dir, { room: "bedroom", confidence: 0.97 });
  const r = runTagAuto(["--threshold=0.5", "--model=test-vlm"], {
    ...sandbox.env,
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(r.status, 0, `real run exits 0, got: ${r.out}`);
  const check = new Database(sandbox.dbPath, { readonly: true });
  const row = check
    .prepare("SELECT room_type, tagged_by, notes FROM image_tags WHERE image_id = 'img0'")
    .get() as { room_type: string; tagged_by: string; notes: string } | undefined;
  check.close();
  assert.ok(row, "the confident verdict was written");
  assert.equal(row!.room_type, "bedroom");
  assert.equal(row!.tagged_by, "local-vlm", "taggedBy is local-vlm, not claude-code/user");
  assert.equal(row!.notes, "local:test-vlm", "notes identify the model that wrote the tag");
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

// --- (c) --threshold=0 and --threshold=1 are accepted, not rejected as falsy/missing ---
{
  const sandbox = makeSandbox(0); // nothing untagged: exercises the guard, not classification
  for (const t of ["0", "1"]) {
    const r = runTagAuto([`--threshold=${t}`], sandbox.env);
    assert.equal(r.status, 0, `--threshold=${t} must be accepted, got: ${r.out}`);
    assert.doesNotMatch(
      r.out,
      /Usage: npm run tag:auto/,
      `--threshold=${t} must not hit the usage-rejection path`,
    );
    assert.match(r.out, /Nothing untagged/, `--threshold=${t} reaches the real run, not the guard`);
  }
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

// --- (d) F5: a below-threshold verdict is queued as JSON on stdout — the
// same shape tag:list uses — and NOT written to the DB. This is the actual
// handoff interface to Claude's Read-tool loop, so a regression that dropped
// absPath, or emitted the queue on the wrong stream, must fail a test. ---
{
  const sandbox = makeSandbox(1);
  const preload = fetchStubPreloadUrl(sandbox.dir, { room: "kitchen", confidence: 0.4 });
  const r = runTagAuto(["--threshold=0.9", "--model=test-vlm"], {
    ...sandbox.env,
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(r.status, 0, `below-threshold-only run exits 0, got: ${r.out}`);

  const check = new Database(sandbox.dbPath, { readonly: true });
  const taggedCount = (
    check.prepare("SELECT COUNT(*) c FROM image_tags").get() as { c: number }
  ).c;
  check.close();
  assert.equal(taggedCount, 0, "a below-threshold verdict must not write a tag");

  // stdout must be pure JSON — progress/error lines belong on stderr only.
  let queue: Array<Record<string, unknown>> = [];
  let parseError: unknown;
  try {
    queue = JSON.parse(r.stdout);
  } catch (e) {
    parseError = e;
  }
  assert.equal(
    parseError,
    undefined,
    `stdout must be exactly the JSON queue, got: ${JSON.stringify(r.stdout)}`,
  );
  assert.equal(queue.length, 1, "one below-threshold photo is queued");
  const entry = queue[0];
  assert.equal(entry.imageId, "img0");
  assert.ok(
    typeof entry.absPath === "string" && entry.absPath.length > 0,
    "absPath is present — this is the field Claude's Read tool needs",
  );
  assert.equal(entry.suggested, "kitchen");
  assert.equal(entry.confidence, 0.4);
  assert.ok(
    r.stderr.length > 0,
    "progress/summary output went to stderr, confirming the streams are genuinely separate",
  );
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

// --- a tag written by another process mid-run is never overwritten (TOCTOU) ---
// tag-auto snapshots the untagged list once via listUntaggedImages, then
// writes minutes/photos later. Reverting setImageTagIfAbsent back to
// setImageTag is the exact regression this pins: it would silently clobber
// a hand tag made (via the UI or tag:set) after the snapshot but before
// tag-auto reaches that image. Simulated deterministically: the fetch stub
// itself performs the "concurrent" write, as a side effect of answering the
// FIRST classification call, before the run reaches the second image.
{
  const sandbox = makeSandbox(2); // img0, img1 both untagged at snapshot time
  const betterSqlite3Url = pathToFileURL(require.resolve("better-sqlite3")).href;
  const preloadPath = path.join(sandbox.dir, "stub-fetch-race-preload.mjs");
  fs.writeFileSync(
    preloadPath,
    `import Database from ${JSON.stringify(betterSqlite3Url)};
const db = new Database(${JSON.stringify(sandbox.dbPath)});
let armed = false;
globalThis.fetch = async () => {
  if (!armed) {
    armed = true;
    // Simulates a hand tag (UI PATCH / tag:set) landing on img1 after
    // tag-auto's snapshot but before its loop gets there.
    db.prepare(
      "INSERT INTO image_tags (image_id, room_type, confidence, tagged_by, tagged_at, notes) VALUES ('img1', 'kitchen', 1.0, 'user', ?, 'hand-tagged mid-run')",
    ).run(new Date().toISOString());
  }
  return {
    ok: true,
    status: 200,
    json: async () => (${JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ room: "bedroom", confidence: 0.95 }) } }] },
    )}),
    text: async () => "",
  };
};
`,
  );
  const preload = pathToFileURL(preloadPath).href;
  const r = runTagAuto(["--threshold=0.5", "--model=test-vlm"], {
    ...sandbox.env,
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(r.status, 0, `run exits 0, got: ${r.out}`);
  assert.match(r.out, /1 skipped \(already tagged\)/, "the race is reported as skipped, not written");
  const check = new Database(sandbox.dbPath, { readonly: true });
  const row = check
    .prepare("SELECT room_type, tagged_by, notes FROM image_tags WHERE image_id = 'img1'")
    .get() as { room_type: string; tagged_by: string; notes: string };
  check.close();
  assert.equal(row.tagged_by, "user", "the hand tag made mid-run must survive untouched");
  assert.equal(row.room_type, "kitchen", "tag-auto's own verdict (bedroom) must not have overwritten it");
  assert.equal(row.notes, "hand-tagged mid-run");
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// bench-report: anti-inflation property (W3). Rule-tagged rows (SVG -> other)
// are right 100% of the time by construction, so they must never leak into
// the figures a human reads to pick --threshold — that number gets converted
// into an irreversible 7,822-row write. Pinned by mutation: changing
// bench-report.ts's `const modelRows = rows.filter(r => r.source !== "rule")`
// to `const modelRows = rows;` must fail every assertion in this block.
// ---------------------------------------------------------------------------
{
  const mixedRows: BenchRow[] = [
    { imageId: "m1", truth: "kitchen", got: "kitchen", confidence: 0.9, source: "model" },
    { imageId: "m2", truth: "bedroom", got: "bedroom", confidence: 0.95, source: "model" },
    { imageId: "m3", truth: "living", got: "dining", confidence: 0.6, source: "model" },
    // Two always-correct rule rows. If they leak into the model figures,
    // agreement/precision/recall/buckets/threshold-table all shift.
    { imageId: "r1", truth: "other", got: "other", confidence: 1, source: "rule" },
    { imageId: "r2", truth: "other", got: "other", confidence: 1, source: "rule" },
  ];
  const mixedReport = renderReport(mixedRows, 0, {
    model: "test-vlm",
    elapsedMs: 30_000,
    outPath: "/tmp/_tagbench.jsonl",
    propertyCount: 2,
    photoCount: 5,
    timestamp: "2026-07-31T00:00:00.000Z",
  });

  assert.match(
    mixedReport,
    /Rule-tagged \(SVG → other\): 2 photos, not included in the figures below/,
    "the rule-tagged count is reported on its own line",
  );

  // Overall agreement: 2 of 3 MODEL rows correct (kitchen, bedroom) — not
  // 4/5, which is what leaking the 2 always-correct rule rows would produce.
  assert.match(
    mixedReport,
    /Overall agreement with your tags: 66\.7% \(2\/3\)/,
    "rule rows must not inflate the overall agreement denominator",
  );
  assert.doesNotMatch(mixedReport, /\(4\/5\)/, "the leaked-rule-rows figure must never appear anywhere");

  // Confusion matrix: the "other" truth row must total 0 model rows, not 2.
  const otherConfusionLine = mixedReport.split("\n").find((l) => l.startsWith("other"));
  assert.ok(otherConfusionLine, "report has a confusion-matrix row for other");
  assert.equal(
    otherConfusionLine!.match(/\d+/g)!.at(-1),
    "0",
    "confusion matrix 'other' truth-row total must be 0 — the 2 rule rows must not appear",
  );

  // Precision/recall for "other": zero model rows means n/a, not the 100%/100%
  // the 2 rule rows would manufacture.
  const otherPRLine = mixedReport
    .split("\n")
    .find((l) => l.trim().startsWith("other") && l.includes("precision"));
  assert.ok(otherPRLine, "report has a precision/recall line for other");
  assert.match(otherPRLine!, /precision n\/a/, "rule rows must not manufacture an 'other' precision figure");
  assert.match(otherPRLine!, /recall n\/a/, "rule rows must not manufacture an 'other' recall figure");

  // Confidence buckets: the 0.95+ bucket must count only the 1 model row at
  // 0.95, not 3 (the 2 rule rows sit at confidence 1.0, inside the same bucket).
  const bucket95Line = mixedReport.split("\n").find((l) => l.includes("conf 0.95+"));
  assert.ok(bucket95Line, "report has a 0.95+ confidence bucket line");
  assert.match(
    bucket95Line!,
    /n=\s*1\s/,
    "the 0.95+ bucket must count 1 model row, not 3 (1 model + 2 leaked rule rows)",
  );

  // Threshold table: at t=0.90, only the 2 model rows >= 0.90 qualify (2/3),
  // not 4/5 if the 2 rule rows (confidence 1.0) leaked in.
  const t090Line = mixedReport.split("\n").find((l) => l.includes("--threshold=0.90"));
  assert.ok(t090Line, "report has a threshold=0.90 line");
  assert.match(
    t090Line!,
    /auto-tags 66\.7% \(2\/3\)/,
    "rule rows must not inflate the threshold table's auto-tag count",
  );
}

// ---------------------------------------------------------------------------
// image-prep: sniffFormat (magic bytes only) and prepareImage (ffmpeg
// conversion / SVG short-circuit / unreadable-file error dialect).
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import {
  sniffFormat,
  prepareImage,
  FFMPEG_MISSING_MESSAGE,
} from "../src/lib/image-prep";

// --- sniffFormat: every format, from bytes only — never the filename ---
assert.equal(
  sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
  "jpeg",
);
assert.equal(
  sniffFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "png",
);
assert.equal(sniffFormat(Buffer.from("GIF89a", "ascii")), "gif");
assert.equal(
  sniffFormat(
    Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
    ]),
  ),
  "webp",
);
assert.equal(
  sniffFormat(Buffer.from('<?xml version="1.0"?><svg></svg>', "utf8")),
  "svg",
  "an SVG that begins with <?xml",
);
assert.equal(
  sniffFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8")),
  "svg",
  "an SVG that begins with <svg (no XML prolog)",
);
assert.equal(
  sniffFormat(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])),
  "unknown",
);

/**
 * Reads a baseline JPEG's own SOFn marker to recover the dimensions ffmpeg
 * actually produced — no new dependency; ffmpeg (already a hard requirement
 * of this feature) is the only external tool involved anywhere in this file.
 */
function jpegDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error("not a JPEG: missing SOI marker");
  }
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) throw new Error(`expected a marker at byte ${offset}`);
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: no SOF marker was found before it
    const length = buf.readUInt16BE(offset + 2);
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("no SOF marker found in JPEG");
}

// --- prepareImage: a real webp fixture, built via ffmpeg at test setup
// (never read from data/images) — converts to a real JPEG capped at maxEdge ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-image-prep-webp-"));
  const webpFixture = path.join(dir, "fixture.webp");
  // 2000x1000 synthetic source so the maxEdge cap is genuinely exercised.
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=2000x1000",
    "-frames:v",
    "1",
    webpFixture,
  ]);
  assert.equal(
    sniffFormat(fs.readFileSync(webpFixture)),
    "webp",
    "the fixture built for this test is really webp",
  );

  const prepared = prepareImage(webpFixture, { maxEdge: 300 });
  assert.equal(prepared.kind, "image");
  if (prepared.kind === "image") {
    assert.equal(prepared.mime, "image/jpeg");
    assert.equal(sniffFormat(prepared.buffer), "jpeg", "prepareImage's output is a real jpeg");
    const { width, height } = jpegDimensions(prepared.buffer);
    assert.ok(
      width <= 300 && height <= 300,
      `long edge must be <= maxEdge=300, got ${width}x${height}`,
    );
    assert.ok(
      width === 300 || height === 300,
      `the long edge should actually reach the cap for a 2000x1000 source, got ${width}x${height}`,
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- prepareImage: a real multi-frame GIF fixture (regression pin for C1).
// Every GIF is multi-frame; `-f image2` writing to "pipe:1" with no frame
// limit fails with "Cannot write more than one file with the same name" for
// every one of them (measured: 99/99 real GIFs in the library failed before
// -frames:v 1 was added). Built the same way as the webp fixture above —
// never read from data/images. ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-image-prep-gif-"));
  const gifFixture = path.join(dir, "fixture.gif");
  // A short animated testsrc so ffmpeg's GIF encoder genuinely emits
  // multiple frames, not a degenerate single-frame GIF.
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=5:duration=2",
    gifFixture,
  ]);
  const frameCount = Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "csv=p=0",
        gifFixture,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  assert.ok(frameCount > 1, `the fixture must genuinely be multi-frame, got ${frameCount} frame(s)`);
  assert.equal(sniffFormat(fs.readFileSync(gifFixture)), "gif", "the fixture is really a gif");

  const prepared = prepareImage(gifFixture, { maxEdge: 200 });
  assert.equal(prepared.kind, "image", "a multi-frame gif must still convert, not throw");
  if (prepared.kind === "image") {
    assert.equal(prepared.mime, "image/jpeg");
    assert.equal(
      sniffFormat(prepared.buffer),
      "jpeg",
      "prepareImage's output is a real, single-frame, decodable jpeg",
    );
    const { width, height } = jpegDimensions(prepared.buffer);
    assert.ok(width <= 200 && height <= 200, `long edge <= maxEdge=200, got ${width}x${height}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- prepareImage: SVG bytes -> { kind: "svg" }, and ffmpeg is never
// invoked. Verified by clearing PATH so ffmpeg would be unresolvable and
// confirming prepareImage still succeeds (rather than throwing the
// ffmpeg-missing error it would throw if it had actually tried to spawn
// ffmpeg) — a spy can't observe this reliably because reassigning
// child_process's execFileSync after an ES module has already imported the
// named binding does not affect that module's calls. ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-image-prep-svg-"));
  const svgFixture = path.join(dir, "agent-logo.svg");
  fs.writeFileSync(svgFixture, "<svg><circle/></svg>");

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  let result;
  try {
    result = prepareImage(svgFixture);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.deepEqual(result, { kind: "svg" }, "SVG short-circuits without touching ffmpeg at all");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- prepareImage: a nonexistent path throws "Could not read image at",
// distinguishable from a down server ---
{
  const missing = path.join(os.tmpdir(), "pc-image-prep-does-not-exist.png");
  assert.throws(
    () => prepareImage(missing),
    (e: Error) => {
      assert.match(e.message, /Could not read image at/i);
      assert.doesNotMatch(e.message, /not reachable/i);
      assert.ok(e.message.includes(missing), "names the missing path");
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// classifyRoom on an SVG: a rule verdict, model never called
// ---------------------------------------------------------------------------
{
  let httpCalled = false;
  globalThis.fetch = (async () => {
    httpCalled = true;
    throw new Error("classifyRoom must not call the model for an SVG");
  }) as unknown as typeof fetch;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-classify-svg-"));
  const svgFixture = path.join(dir, "agent-logo.svg");
  fs.writeFileSync(svgFixture, "<svg><circle/></svg>");

  const verdict = await classifyRoom(svgFixture, "vision-model-x");
  assert.deepEqual(verdict, { room: "other", confidence: 1, source: "rule" });
  assert.equal(httpCalled, false, "no HTTP call was made for an SVG");

  fs.rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
// tagging-run: classifyFailure — previously had no test coverage at all.
// Cover every branch, including the new ffmpeg-missing one.
// ---------------------------------------------------------------------------
import {
  classifyFailure,
  CONSECUTIVE_FAILURE_LIMIT,
  circuitBreakerMessage,
} from "../src/lib/tagging-run";

assert.equal(CONSECUTIVE_FAILURE_LIMIT, 10, "the breaker trips after 10 consecutive failures");

assert.equal(
  classifyFailure(
    "Local model server not reachable at http://127.0.0.1:1234/v1 — is LM Studio's server running with a model loaded? (fetch failed)",
  ),
  "not-reachable",
  "a down server aborts the run",
);
assert.equal(
  classifyFailure(FFMPEG_MISSING_MESSAGE),
  "ffmpeg-missing",
  "the exact message image-prep.ts throws when ffmpeg is missing classifies as ffmpeg-missing",
);
assert.equal(
  classifyFailure("Could not read image at /tmp/foo.png: ENOENT: no such file or directory"),
  "unreadable-image",
  "a per-photo unreadable/unconvertible file is a skip, not an abort",
);
assert.equal(
  classifyFailure("Local model reply was not JSON: I think it's a kitchen!"),
  "other",
  "a bad reply is a per-photo failure that feeds the breaker",
);
assert.equal(
  classifyFailure("Local model returned no message content"),
  "other",
);
assert.equal(
  classifyFailure(`Local model call to http://x timed out after 120000ms — the server may be stalled`),
  "other",
  "a timeout is a per-photo failure, not an abort",
);

// ffmpeg-missing must not be mistaken for either of the other two abort/skip
// dialects, even though it shares the run-aborting behaviour of not-reachable.
assert.notEqual(classifyFailure(FFMPEG_MISSING_MESSAGE), "not-reachable");
assert.notEqual(classifyFailure(FFMPEG_MISSING_MESSAGE), "unreadable-image");

assert.match(
  circuitBreakerMessage(CONSECUTIVE_FAILURE_LIMIT),
  /10 consecutive failures/,
  "the breaker message names the count that tripped it",
);

console.log("✓ local-llm.test: all assertions passed");
