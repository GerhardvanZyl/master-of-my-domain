# Local Model Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local vision model on the RX 7900 XTX does first-pass room classification for listing photos, and Claude reads only the photos the model is unsure about.

**Architecture:** LM Studio serves an OpenAI-compatible endpoint on `127.0.0.1:1234`. A ~60-line transport module (`src/lib/local-llm.ts`) posts JSON-schema-constrained requests to it. A domain module (`src/lib/room-classify.ts`) owns the room prompt, the reply schema, and the confidence gate — shared by both scripts so the benchmark measures the prompt that ships. `scripts/tag-bench.ts` measures accuracy against already-tagged photos and writes nothing; `scripts/tag-auto.ts` writes tags for untagged photos through the existing `setImageTag` path.

**Tech Stack:** TypeScript, tsx (CLI scripts), better-sqlite3, `node:assert` for tests, `fetch` (no new npm dependency), LM Studio + a Qwen3-VL 8B-class GGUF.

Spec: `docs/superpowers/specs/2026-07-30-local-model-offload-design.md`

## Global Constraints

- **Never write to `data/app.db` outside the sanctioned query helpers in `src/db/queries/tags.ts`.** No raw SQL writes in scripts. (CLAUDE.md)
- **`scripts/tag-bench.ts` must not import any write helper.** Not `setImageTag`, not `ensureGroup`, not `addGroupMember`. A benchmark run mutating the DB is a defect, not a nuisance.
- **`scripts/tag-auto.ts` iterates `listUntaggedImages` only.** The 7,822 existing tags must be unreachable by construction, not merely by a conditional.
- **`tag-auto` has no default threshold.** Missing `--threshold` is a usage error and exits 1.
- **The room vocabulary is exactly `ROOM_TYPES` from `src/db/schema.ts`:** `kitchen`, `bathroom`, `bedroom`, `living`, `dining`, `exterior`, `other`. Never hardcode this list — import it.
- **One prompt constant, shared.** If bench and auto build their own prompts, the benchmark number is worthless.
- **No new npm dependencies.** `fetch`, `node:fs`, `node:path`, `Buffer` cover it.
- **Scripts degrade, they don't corrupt.** Server unreachable → non-zero exit, nothing written. Same posture as the scrapers.
- **Test idiom:** top-level `node:assert` calls in a flat `.ts` file, ending with `console.log("✓ <name>: all assertions passed")`. No framework, no fixtures. Match `test/units.test.ts`.
- **ESM + top-level await are available** (`"type": "module"` in package.json, run via tsx).

### Deviations from the spec, and why

Three, all discovered by reading the actual code. Implement the plan's version, not the spec's.

1. **`src/lib/local-llm.ts`, not `src/local/llm.ts`.** `src/lib/` is where this repo keeps utilities (`args.ts`, `env.ts`, `format.ts`, `images.ts`). One file does not earn a new top-level directory.
2. **`--properties=id1,id2,id3` (comma list), not a repeatable `--property=`.** `parseFlags` returns `Record<string, string | boolean>` and structurally cannot represent a repeated flag; making it repeatable would change its return type and every existing caller's narrowing. A comma list costs one `.split(",")`.
3. **`tag-auto` sets `taggedBy: "local-vlm"` *in addition to* `notes: "local:<model>"`.** The spec only asked for notes, but `image_tags.tagged_by` already exists and defaults to `"claude-code"` — it is the correct queryable field for "who labelled this". Notes keeps the specific model name.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/local-llm.ts` (create) | Transport only. One HTTP call to an OpenAI-compatible server, image encoding, schema-constrained reply parsing, clear errors. Knows nothing about rooms. |
| `src/lib/room-classify.ts` (create) | Domain. The room prompt, the reply schema, verdict validation, the confidence gate. Knows nothing about HTTP or SQL. |
| `src/db/queries/tags.ts` (modify) | Add two read-only queries: `listTaggedImages`, `topTaggedProperties`. |
| `scripts/tag-bench.ts` (create) | Measurement + reporting. Read-only. |
| `scripts/tag-auto.ts` (create) | The worker. The only new file that writes. |
| `test/local-llm.test.ts` (create) | Unit tests for the transport payload, the error paths, verdict validation, and the gate boundary. |
| `package.json` (modify) | Two npm scripts, plus the new test file in `npm test`. |

---

## Task 1: LM Studio serving a vision model

No code. This is a prerequisite with a verifiable deliverable, so it gets its own gate.

**Files:** none.

**Interfaces:**
- Consumes: nothing.
- Produces: a reachable OpenAI-compatible endpoint at `http://127.0.0.1:1234/v1` and the exact model id string that later tasks pass as `--model`.

- [ ] **Step 1: Install LM Studio**

Download from `https://lmstudio.ai` and install. It ships a Vulkan llama.cpp runtime that works on RDNA3 (7900 XTX) under Windows with no compilation. Do not chase ROCm on Windows.

- [ ] **Step 2: Confirm the GPU runtime is the one selected**

In LM Studio, open the runtime/hardware settings and confirm a **Vulkan** runtime is active and the 7900 XTX is the selected device. If it fell back to CPU, classification will be roughly an order of magnitude slower and the benchmark will be tedious rather than wrong.

- [ ] **Step 3: Download a vision model**

In the model browser, search `Qwen3-VL 8B`. Pick a Q4_K_M–Q5_K_M GGUF that the browser reports as a **full GPU offload fit** for 24GB. Confirm the model is listed as vision-capable — a text-only Qwen3 8B will download happily and then fail on every image.

If Qwen3-VL is unavailable in the browser, `Qwen2.5-VL-7B-Instruct` is the fallback; the prompt and schema are unchanged.

- [ ] **Step 4: Start the server**

Load the model, open the Developer/Server tab, start the server on port `1234`. Note the exact model id string LM Studio shows (e.g. `qwen/qwen3-vl-8b`) — that string is what `--model` takes.

- [ ] **Step 5: Verify the endpoint from this repo's shell**

Run:
```bash
curl -s http://127.0.0.1:1234/v1/models
```
Expected: JSON listing the loaded model, including the id from Step 4.

If this returns nothing, the server is not started — no amount of later code will fix it.

- [ ] **Step 6: Record the model id as a default**

Create or append to `.env.local` in the project root:
```
LOCAL_VLM_MODEL=<exact model id from Step 4>
```
`src/lib/load-env.ts` already loads `.env.local` for CLI scripts. `.env.local` is gitignored, so nothing to commit in this task.

---

## Task 2: The transport module

**Files:**
- Create: `src/lib/local-llm.ts`
- Create: `test/local-llm.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `askLocal(opts: AskLocalOptions): Promise<unknown>` — returns the parsed JSON object from the model's reply.
  - `interface AskLocalOptions { model: string; prompt: string; system?: string; imagePath?: string; schema: Record<string, unknown>; schemaName?: string; baseUrl?: string; timeoutMs?: number }`

- [ ] **Step 1: Write the failing test**

Create `test/local-llm.test.ts`:

```ts
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
assert.ok(parts[1].image_url.url.length > 30, "image bytes are actually encoded");

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/local-llm.test.ts`
Expected: FAIL — cannot find module `../src/lib/local-llm`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/local-llm.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:1234/v1";

export interface AskLocalOptions {
  model: string;
  prompt: string;
  system?: string;
  /** Absolute path to an image to attach. Omit for text-only calls. */
  imagePath?: string;
  /** JSON Schema the reply must satisfy — the server enforces it. */
  schema: Record<string, unknown>;
  schemaName?: string;
  /** Defaults to $LOCAL_LLM_URL, then http://127.0.0.1:1234/v1. */
  baseUrl?: string;
  timeoutMs?: number;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function dataUrl(p: string): string {
  const mime = MIME[path.extname(p).toLowerCase()] ?? "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
}

/**
 * One call to a local OpenAI-compatible server (LM Studio by default).
 * Returns the parsed JSON reply. Throws with an actionable message on any
 * failure — callers decide whether to skip the item or abort the run.
 */
export async function askLocal(opts: AskLocalOptions): Promise<unknown> {
  const base = opts.baseUrl ?? process.env.LOCAL_LLM_URL ?? DEFAULT_BASE;
  const content: unknown[] = [{ type: "text", text: opts.prompt }];
  if (opts.imagePath) {
    content.push({
      type: "image_url",
      image_url: { url: dataUrl(opts.imagePath) },
    });
  }

  const body = {
    model: opts.model,
    temperature: 0,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName ?? "reply",
        strict: true,
        schema: opts.schema,
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Local model server not reachable at ${base} — is LM Studio's server running with a model loaded? (${why})`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`Local model server returned ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("Local model returned no message content");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Local model reply was not JSON: ${text.slice(0, 200)}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/local-llm.test.ts`
Expected: PASS — `✓ local-llm.test: all assertions passed`

- [ ] **Step 5: Wire the test file into `npm test`**

In `package.json`, append the new file to the `test` script so it runs with the rest:

```json
"test": "tsx test/units.test.ts && tsx test/adapters.test.ts && tsx test/features.test.ts && tsx test/pipeline.test.ts && tsx test/ingest.test.ts && tsx test/shares.test.ts && tsx test/local-llm.test.ts",
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: every test file prints its ✓ line, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/local-llm.ts test/local-llm.test.ts package.json
git commit -m "feat: askLocal() client for a local OpenAI-compatible model server"
```

---

## Task 3: Room prompt, schema, and the confidence gate

**Files:**
- Create: `src/lib/room-classify.ts`
- Modify: `test/local-llm.test.ts` (append a section)

**Interfaces:**
- Consumes: `askLocal` from Task 2.
- Produces:
  - `ROOM_PROMPT: string`
  - `ROOM_SCHEMA: Record<string, unknown>`
  - `DEFAULT_VISION_MODEL: string`
  - `interface RoomVerdict { room: RoomType; confidence: number }`
  - `parseRoomVerdict(raw: unknown): RoomVerdict` — throws on an out-of-vocabulary room or an out-of-range confidence.
  - `classifyRoom(absPath: string, model?: string): Promise<RoomVerdict>`
  - `passesGate(v: RoomVerdict, threshold: number): boolean`

- [ ] **Step 1: Write the failing test**

Append to `test/local-llm.test.ts`, immediately **before** the final `globalThis.fetch = realFetch;` line:

```ts
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
```

Note: the `import` statements sit mid-file. That is legal — ESM hoists imports — and it keeps this test section readable next to what it tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/local-llm.test.ts`
Expected: FAIL — cannot find module `../src/lib/room-classify`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/room-classify.ts`:

```ts
import { ROOM_TYPES, type RoomType } from "@/db/schema";
import { askLocal } from "./local-llm";

/** Set LOCAL_VLM_MODEL in .env.local to the model id LM Studio reports. */
export const DEFAULT_VISION_MODEL =
  process.env.LOCAL_VLM_MODEL ?? "qwen/qwen3-vl-8b";

/**
 * The one prompt. Both tag:bench and tag:auto use it — if they diverged, the
 * benchmark would measure a prompt that never ships.
 */
export const ROOM_PROMPT = `You are labelling one photo from an Australian real-estate listing.
Pick exactly one room type from this list: ${ROOM_TYPES.join(", ")}.

Rules for the cases that are actually confusable:
- An open-plan shot showing both a lounge setting and a dining table -> living.
- A room whose main subject is a dining table -> dining.
- A room whose main subject is a bed -> bedroom.
- Floorplans, site plans, locality maps, agent branding, price or text overlays,
  and close-up detail shots with no readable room -> other.
- Facade, street view, driveway, backyard, garden, balcony, deck, pool -> exterior.
- Ensuite, powder room, toilet, and a laundry containing a basin -> bathroom.
  A laundry with no basin -> other.

confidence is your own probability that your label is correct: 1.0 means
certain, 0.5 means you are choosing between two plausible types. Be honest — a
low number is useful because it routes the photo to a human, an inflated one
puts a wrong label in the database.`;

export const ROOM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    room: { type: "string", enum: [...ROOM_TYPES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["room", "confidence"],
  additionalProperties: false,
};

export interface RoomVerdict {
  room: RoomType;
  confidence: number;
}

/** Validate a model reply. The server enforces the schema; this is the belt. */
export function parseRoomVerdict(raw: unknown): RoomVerdict {
  const o = raw as { room?: unknown; confidence?: unknown } | null;
  const room = o?.room;
  if (
    typeof room !== "string" ||
    !(ROOM_TYPES as readonly string[]).includes(room)
  ) {
    throw new Error(`Model returned an invalid room: ${JSON.stringify(room)}`);
  }
  const c = o?.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
    throw new Error(
      `Model returned an invalid confidence: ${JSON.stringify(c)}`,
    );
  }
  return { room: room as RoomType, confidence: c };
}

export async function classifyRoom(
  absPath: string,
  model: string = DEFAULT_VISION_MODEL,
): Promise<RoomVerdict> {
  return parseRoomVerdict(
    await askLocal({
      model,
      prompt: ROOM_PROMPT,
      imagePath: absPath,
      schema: ROOM_SCHEMA,
      schemaName: "room_verdict",
    }),
  );
}

/**
 * The gate. At or above the threshold a tag may be written; below it the photo
 * stays untagged and queues for human review. Inclusive at the boundary.
 */
export function passesGate(v: RoomVerdict, threshold: number): boolean {
  return v.confidence >= threshold;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/local-llm.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all files pass, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/room-classify.ts test/local-llm.test.ts
git commit -m "feat: shared room prompt, reply schema, and confidence gate"
```

---

## Task 4: Read-only queries for the benchmark

**Files:**
- Modify: `src/db/queries/tags.ts` (append after `listUntaggedImages`, around line 47)

**Interfaces:**
- Consumes: the existing `UntaggedImage` interface, `sqlite`, `DATA_DIR`, `RoomType` — all already imported at the top of the file.
- Produces:
  - `interface TaggedImage extends UntaggedImage { roomType: RoomType }`
  - `listTaggedImages(opts?: { propertyIds?: string[]; limit?: number }): TaggedImage[]`
  - `topTaggedProperties(n: number): string[]`

- [ ] **Step 1: Write the implementation**

These are read-only SELECTs against the real DB. There is no meaningful unit test that does not either duplicate the SQL or need a fixture database the repo does not have — Step 2 verifies them by running them, which is the honest check. (`test/ui.test.ts` is the only test that touches a DB, and it copies the real one.)

Append to `src/db/queries/tags.ts`, after `listUntaggedImages`:

```ts
export interface TaggedImage extends UntaggedImage {
  roomType: RoomType;
}

/**
 * Images that already have a room_type — the ground truth a local model gets
 * benchmarked against. Read-only.
 */
export function listTaggedImages(
  opts: { propertyIds?: string[]; limit?: number } = {},
): TaggedImage[] {
  const clauses = ["t.room_type IS NOT NULL"];
  const args: unknown[] = [];
  if (opts.propertyIds && opts.propertyIds.length > 0) {
    clauses.push(
      `i.property_id IN (${opts.propertyIds.map(() => "?").join(",")})`,
    );
    args.push(...opts.propertyIds);
  }
  let sql = `SELECT i.id AS imageId, i.property_id AS propertyId,
      p.address AS address, i.ordinal AS ordinal, i.local_path AS localPath,
      t.room_type AS roomType
    FROM images i
    JOIN properties p ON p.id = i.property_id
    JOIN image_tags t ON t.image_id = i.id
    WHERE ${clauses.join(" AND ")}
    ORDER BY i.property_id, i.ordinal`;
  if (opts.limit && opts.limit > 0) sql += ` LIMIT ${Math.floor(opts.limit)}`;

  const rows = sqlite.prepare(sql).all(...args) as Omit<
    TaggedImage,
    "absPath"
  >[];
  return rows.map((r) => ({
    ...r,
    absPath: path.resolve(DATA_DIR, r.localPath),
  }));
}

/** The n properties with the most tagged photos — the default benchmark sample. */
export function topTaggedProperties(n: number): string[] {
  const rows = sqlite
    .prepare(
      `SELECT i.property_id AS id, COUNT(*) AS c
       FROM images i JOIN image_tags t ON t.image_id = i.id
       WHERE t.room_type IS NOT NULL
       GROUP BY i.property_id
       ORDER BY c DESC, i.property_id
       LIMIT ?`,
    )
    .all(Math.floor(n)) as { id: string }[];
  return rows.map((r) => r.id);
}
```

- [ ] **Step 2: Verify against the real DB**

Run:
```bash
npx tsx -e "import './src/lib/load-env.ts'; const t = await import('./src/db/queries/tags.ts'); const ids = t.topTaggedProperties(10); console.log('properties:', ids.length); const imgs = t.listTaggedImages({ propertyIds: ids }); console.log('photos:', imgs.length); console.log(imgs[0]);"
```

Expected: `properties: 10`, a photo count in the low hundreds (~250-300), and a first row with a non-null `roomType` and an `absPath` that exists on disk. If `photos:` is 0, the JOIN is wrong.

- [ ] **Step 3: Confirm no write path was touched**

Run: `git diff src/db/queries/tags.ts | grep -E "^\+" | grep -iE "INSERT|UPDATE|DELETE"`
Expected: no output. Both additions are SELECTs.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: pass — nothing existing changed.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/tags.ts
git commit -m "feat: listTaggedImages + topTaggedProperties read queries for benchmarking"
```

---

## Task 5: The benchmark script

**Files:**
- Create: `scripts/tag-bench.ts`
- Modify: `package.json` (add `tag:bench`)

**Interfaces:**
- Consumes: `listTaggedImages`, `topTaggedProperties` (Task 4); `classifyRoom`, `DEFAULT_VISION_MODEL` (Task 3); `parseFlags`, `DATA_DIR`, `ROOM_TYPES`.
- Produces: a CLI (`npm run tag:bench`) and `data/_tagbench.jsonl`.

- [ ] **Step 1: Write the implementation**

Create `scripts/tag-bench.ts`:

```ts
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
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after `"tag:status"`:

```json
"tag:bench": "tsx scripts/tag-bench.ts",
```

- [ ] **Step 3: Verify the read-only constraint by inspection**

Run: `grep -nE "setImageTag|ensureGroup|addGroupMember|INSERT|UPDATE|DELETE" scripts/tag-bench.ts`
Expected: no output. If anything matches, the constraint is violated — fix before continuing.

- [ ] **Step 4: Smoke-test on two photos**

With LM Studio's server running (Task 1):
```bash
npm run tag:bench -- --limit=2
```
Expected: two classifications, then the full report with tiny counts. Confirms the model answers, the schema holds, and the report renders. If every call errors with "not reachable", go back to Task 1 Step 5.

- [ ] **Step 5: Confirm the DB was not modified**

Run:
```bash
npx tsx -e "import './src/lib/load-env.ts'; const t = await import('./src/db/queries/tags.ts'); console.log(JSON.stringify(t.tagStatus()).slice(0,120));"
```
Expected: `totalImages: 7822, tagged: 7822, untagged: 0` — unchanged. The benchmark must leave no trace in the DB.

- [ ] **Step 6: Commit**

```bash
git add scripts/tag-bench.ts package.json
git commit -m "feat: tag:bench — measure a local VLM against existing room tags"
```

---

## Task 6: Run the benchmark and choose the threshold

No code. This task's deliverable is a number, and Task 7 cannot be completed without it.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-local-model-offload-design.md` (record the result)

**Interfaces:**
- Consumes: `npm run tag:bench` from Task 5.
- Produces: the threshold value Task 7's `--threshold` uses, and a recorded accuracy baseline.

- [ ] **Step 1: Run the full benchmark**

```bash
npm run tag:bench 2>progress.log | tee bench-report.txt
```
10 properties, roughly 250-300 photos. Expect single-digit seconds per photo on a fully-offloaded 8B VLM, so 15-45 minutes. Let it finish.

- [ ] **Step 2: Read the confusion matrix**

Look specifically at the `living` row and the `dining` row. Bleed between those two is the failure the spec predicted. Also check how much of your `other` (2,785 photos repo-wide — the largest class) the model reclassifies as a real room; floorplans landing in `living` would be the tell.

- [ ] **Step 3: Pick the threshold from the last table**

The "What tag:auto would have done" table gives, for each threshold, the share auto-tagged and how many of those are wrong. Choose the highest threshold whose auto-tagged accuracy you would accept unreviewed. A reasonable target: **≥95% correct among auto-tagged**, with as much coverage as that allows.

If no threshold reaches an acceptable accuracy at useful coverage, stop and reconsider — that is the signal to try the 32B Q4 model (re-run with `--model=`, then diff against the earlier run in `data/_tagbench.jsonl`), not to lower your standards.

- [ ] **Step 4: Record the result in the spec**

Add a `## Benchmark result (YYYY-MM-DD)` section to the spec file with: the model id, photo count, overall agreement, the chosen threshold, and the expected auto-tag coverage and error rate at that threshold. Six months from now this is the only record of why the number is what it is.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-30-local-model-offload-design.md
git commit -m "docs: record local VLM benchmark result and chosen threshold"
```

Do not commit `bench-report.txt` or `progress.log`; delete them, or note that `data/` is already gitignored if you move them there.

---

## Task 7: The worker

**Files:**
- Create: `scripts/tag-auto.ts`
- Modify: `package.json` (add `tag:auto`)
- Modify: `test/local-llm.test.ts` (append the usage-guard test)

**Interfaces:**
- Consumes: `listUntaggedImages`, `setImageTag` (existing); `classifyRoom`, `passesGate`, `DEFAULT_VISION_MODEL` (Task 3); the threshold from Task 6.
- Produces: a CLI (`npm run tag:auto`) that prints a review queue as JSON on stdout in the same shape `tag:list` uses.

- [ ] **Step 1: Write the failing test for the threshold guard**

The guard is the one piece of `tag-auto` that is worth an automated test — it is what stands between a typo and 30 wrong tags. Append to `test/local-llm.test.ts`, before the final `globalThis.fetch = realFetch;`:

```ts
// --- tag:auto refuses to run without a threshold ---
import { execFileSync } from "node:child_process";

function runTagAuto(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/tag-auto.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/local-llm.test.ts`
Expected: FAIL — `scripts/tag-auto.ts` does not exist, so the process fails for the wrong reason and the `/threshold/i` assertion does not match.

- [ ] **Step 3: Write the implementation**

Create `scripts/tag-auto.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/local-llm.test.ts`
Expected: PASS — all four bad-threshold invocations exit non-zero with a message naming `tag:bench`.

- [ ] **Step 5: Add the npm script**

In `package.json`, after `"tag:bench"`:

```json
"tag:auto": "tsx scripts/tag-auto.ts",
```

- [ ] **Step 6: Verify the no-overwrite constraint by inspection**

Run: `grep -n "listTaggedImages\|listUntaggedImages" scripts/tag-auto.ts`
Expected: exactly one match, `listUntaggedImages`. If `listTaggedImages` appears here, existing tags are reachable and the constraint is broken.

- [ ] **Step 7: Dry-run against real data**

There are currently 0 untagged images, so first confirm the empty path, then create a real test case:

```bash
npm run tag:auto -- --threshold=0.9
```
Expected: `Nothing untagged. Done.` and `[]`.

Then verify the write path end-to-end on a single image without risking anything: pick one image id, note its current room, and use `--dry-run` after temporarily making it untagged is **not** worth it. Instead ingest or wait for a new listing, or verify on the next real listing. Record in the commit message that the write path is exercised on first real use.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/tag-auto.ts test/local-llm.test.ts package.json
git commit -m "feat: tag:auto — confidence-gated local room tagging for untagged photos"
```

---

## Task 8: Document the workflow in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the "Photo-tagging job" section)

**Interfaces:**
- Consumes: the finished CLIs and the threshold from Task 6.
- Produces: the instruction that makes future Claude sessions use the local model first instead of reading all 30 photos.

- [ ] **Step 1: Add the local first-pass to the tagging loop**

In `CLAUDE.md`, under "### The loop", insert a new step before the current step 1:

```markdown
0. **Local first pass.** Run `npm run tag:auto -- --threshold=<T>` (T is recorded
   in `docs/superpowers/specs/2026-07-30-local-model-offload-design.md`; needs
   LM Studio's server running). Confident photos are tagged by the local model
   and marked `tagged_by = 'local-vlm'`. It prints the low-confidence photos as
   JSON in the same shape as `tag:list` — those are the ones you Read yourself.
   If the server is not running the command exits non-zero and writes nothing;
   fall back to step 1 and tag everything by hand.
```

- [ ] **Step 2: Add the two commands to the sanctioned-commands list**

In the "### Commands" list, add:

```markdown
- `npm run tag:auto -- --threshold=<0..1> [--property=<id>] [--limit=N] [--dry-run]`
  → local vision model tags what it is confident about, prints the rest as a
  review queue. Only ever touches untagged images.
- `npm run tag:bench [-- --properties=<id,id> --count=10 --model=<name>]` →
  accuracy of a local model against your existing tags. Writes nothing to the DB.
```

- [ ] **Step 3: Verify the documented commands actually work as written**

Run each command from the docs with `--limit=1` (or `--dry-run`) and confirm the flags parse as documented. Documentation that drifts from the CLI is worse than none.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: local VLM first pass in the photo-tagging loop"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| LM Studio runtime, Vulkan, model choice | 1 |
| `askLocal`, base64 image part, json_schema, clear unreachable error, no new dependency | 2 |
| Shared prompt constant, 7-value vocabulary, disambiguation rules | 3 |
| `listTaggedImages` read query | 4 |
| Benchmark: 10 properties, confusion matrix, precision/recall, confidence buckets, `_tagbench.jsonl`, no write import | 5 |
| Threshold chosen from data, not guessed | 6 |
| Worker: untagged only, gate, `notes: local:<model>`, review queue, non-zero exit on dead server | 7 |
| Tests in `npm test`, stubbed fetch, gate boundary | 2, 3, 7 |
| Phase 2 (`meta-auto.ts`) out of scope | not planned — correct |

No gaps.

**Placeholder scan:** clean. Task 6 is the only task without code, and its deliverable is a specific number plus a recorded spec section, not a "TBD".

**Type consistency check:** `RoomVerdict { room, confidence }` is produced by `parseRoomVerdict`/`classifyRoom` and consumed by `passesGate` in Task 3, and by both scripts in Tasks 5 and 7. `TaggedImage extends UntaggedImage` in Task 4 keeps `absPath` and `roomType` available to Task 5. `DEFAULT_VISION_MODEL` is exported once in Task 3 and imported by both scripts. `setImageTag`'s existing signature (`imageId`, `roomType`, `confidence`, `notes`, `taggedBy`) matches Task 7's call.

One wart fixed inline: Task 7 Step 3's `queue` declaration is now a plain `Array<Record<string, unknown>>`.

**Known soft spot, called out rather than hidden:** Task 7 Step 7 cannot fully exercise the write path today, because `untagged: 0`. The guard, the gate, and the empty path are all verified; the actual `setImageTag` call gets its first real run on the next new listing. The alternative — untagging a real image to test — risks the data this whole design promises not to touch.
