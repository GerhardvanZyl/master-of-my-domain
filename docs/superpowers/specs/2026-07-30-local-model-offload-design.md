# Local model offload — design

Date: 2026-07-30

## Problem

Photo room tagging is the only genuinely model-shaped job in this repo, and it
runs on Claude Code reading every image. 7,822 photos across 288 properties have
been tagged that way, and every new listing adds ~30 more. Everything else the
repo does — scraping, transit times, altitude, price parsing — is deterministic
code that should not involve a model at all.

The machine has an RX 7900 XTX (24GB VRAM) and a 9800X3D with 64GB RAM. That is
enough to run a capable vision-language model locally and hand it the first pass.

## Goal

A local vision model does first-pass room classification. Claude reviews only the
cases the model is unsure about. The same thin client is reused later for a text
job (listing description → structured fields).

Target: Claude reads a fraction of new photos instead of all of them, with the
fraction chosen from measured accuracy rather than guessed.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Runtime | LM Studio | Ships a working Vulkan llama.cpp build for RDNA3 on Windows with no compilation. Model browser reports VRAM fit. Serves an OpenAI-compatible API on `127.0.0.1:1234` with JSON-schema-constrained output. ROCm on Windows is still patchy; Vulkan on this card is fast and boring. |
| Vision model | Qwen3-VL 8B class, ~Q5 | Fits with wide headroom in 24GB. Escalate to a 32B at Q4 (~fits, slower) only if the benchmark shows the 8B cannot separate `living` from `dining`. |
| Text model (phase 2) | Qwen3 30B-A3B class, ~Q4 | MoE, ~3B active parameters, so it reads fast despite the parameter count. |
| Model residency | One at a time | These are batch jobs. Nothing needs both models resident. |
| Trust model | Confidence-gated | Model reports its own confidence. At/above threshold the tag lands directly; below, the photo stays untagged and queues for Claude. |
| Backfill | Benchmark only, 10 properties | Existing tags are free ground truth. Measure against ~270 photos, write nothing. |
| Existing tags | Never overwritten | The worker iterates untagged images only. |

Exact quant tags are chosen in the LM Studio model browser by reported VRAM fit,
not from arithmetic in this document.

## Architecture

Four pieces. One new module, one query addition, two scripts.

```
scripts/tag-bench.ts ──┐
                       ├──> src/local/llm.ts ──HTTP──> LM Studio (127.0.0.1:1234)
scripts/tag-auto.ts  ──┘            │
                                    └── shared prompt constant
scripts/tag-auto.ts ──> src/db/queries/tags.ts (setImageTag — existing write path)
scripts/tag-bench.ts ──> src/db/queries/tags.ts (listTaggedImages — new, read-only)
```

### `src/local/llm.ts` — the local-model layer

One export:

```ts
askLocal({ model, system, prompt, imagePath?, schema }): Promise<unknown>
```

- POSTs to `${process.env.LOCAL_LLM_URL ?? "http://127.0.0.1:1234/v1"}/chat/completions`.
- When `imagePath` is given, the image is read from disk and sent as a base64
  `data:` URL in the standard OpenAI `image_url` content part.
- `response_format: { type: "json_schema", json_schema: { strict: true, ... } }`
  so the reply parses without regex salvage. The parsed object is returned.
- A connection failure throws one clear error naming the URL and stating the
  local model server is not reachable.
- No new npm dependency: `fetch`, `readFileSync`, `Buffer`.

Deliberately absent: provider abstraction, retry/backoff, request pooling.
Switching to Ollama or `llama-server` is changing `LOCAL_LLM_URL` and the model
name, because all three expose the same HTTP shape.

### `src/db/queries/tags.ts` — one addition

```ts
listTaggedImages({ propertyIds?, limit? })
```

Mirrors the existing `listUntaggedImages` return shape (`imageId`, `propertyId`,
`address`, `ordinal`, `absPath`) and additionally returns the stored `roomType`.
Required by the benchmark. Nothing else in the DB layer changes.

### `scripts/tag-bench.ts` — measurement, writes nothing

- Property selection: `--property=<id>` repeatable; with none given, the 10
  properties with the most tagged photos.
- Classifies each photo through `askLocal` with schema
  `{ room: enum(ROOM_TYPES), confidence: number 0..1 }`.
- Prints to stdout:
  1. Overall agreement with the stored tags.
  2. A 7×7 confusion matrix (stored tag × model tag).
  3. Per-room precision and recall.
  4. **Agreement bucketed by the model's reported confidence.**
- Table 4 is the purpose of the script: it is how the `tag-auto` threshold is
  chosen from data instead of picked because a number looks reasonable.
- Raw per-image results are appended to `data/_tagbench.jsonl` with the model
  name, so comparing two models is a diff rather than a re-run.
- **Hard constraint:** this file does not import `setImageTag` or any other
  write helper. It must be impossible for a benchmark run to mutate the DB.

### `scripts/tag-auto.ts` — the worker

- Iterates `listUntaggedImages` only. Existing tags are therefore structurally
  out of reach — not merely avoided by a conditional.
- Flags: `--threshold=<0..1>` (required, no default until the benchmark produces
  one), `--property=<id>`, `--limit=N`, `--model=<name>`, `--dry-run`.
- `confidence >= threshold` → `setImageTag({ imageId, roomType, confidence,
  notes: "local:<model>" })` through the existing sanctioned write path, so
  machine-written tags stay identifiable by query afterwards.
- `confidence < threshold` → the image is left untagged and printed to a review
  queue on stdout (same JSON shape as `tag:list`, so Claude's existing loop can
  consume it unchanged).
- Server unreachable → non-zero exit with a plain message, nothing written.
  Same degrade-don't-corrupt posture the scrapers already follow.

### Prompt

One exported constant shared by both scripts. If the two scripts built their own
prompts, the benchmark would measure a prompt that is not the one shipped.

The seven-value vocabulary is enforced by the JSON schema, so the prompt text is
only disambiguation for the confusable cases:

- open plan showing both a lounge and a table → `living`
- floorplans, locality maps, agent branding, close-up detail shots → `other`
- facade, street view, backyard, balcony, pool → `exterior`
- ensuite, powder room, laundry with a basin → `bathroom` (laundry without → `other`)

## Testing

Added to `npm test`, no server required: prompt assembly and the confidence-gate
decision are pure functions, exercised with a stubbed `fetch`. Specifically that
a below-threshold result produces no write call and an at-threshold result does.

The live-server accuracy run is manual, via `tag-bench`. Mocking a
vision-language model's judgment would test nothing.

## Sequence

1. Install LM Studio, pull a Qwen3-VL 8B-class quant that fits, start the server.
2. `src/local/llm.ts` + the `listTaggedImages` query.
3. `scripts/tag-bench.ts`. Run it over 10 properties. Read the confidence buckets.
4. Pick the threshold from those buckets.
5. `scripts/tag-auto.ts`, wired to that threshold.
6. Unit tests for prompt assembly and the gate.

Phase 2, out of scope for this spec: `scripts/meta-auto.ts` — listing description
to structured fields, same `askLocal`, text model, existing `meta:set` write path.
It goes second because the vision job validates the layer first, and which fields
are worth extracting needs its own design conversation.

## Explicitly not built

- A proposals/staging table. The confidence gate plus "untagged means unreviewed"
  already gives a review queue with no new schema.
- Retry and backoff. A local server on loopback either answers or is down.
- A provider interface. One env var covers the realistic alternatives.
- A concurrent request pool. Add it when 270 sequential images takes long enough
  to be annoying, which is a measurement, not a prediction.
