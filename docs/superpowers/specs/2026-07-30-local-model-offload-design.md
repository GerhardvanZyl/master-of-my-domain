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

As delivered: two scripts over four shared modules plus additions to two existing
ones. (The original design said "one new module"; review findings during
implementation justified `bench-report.ts` and `tagging-run.ts` — see Known
follow-ups.)

```
scripts/tag-bench.ts ──┐
scripts/tag-auto.ts  ──┴──> src/lib/room-classify.ts   ROOM_PROMPT, ROOM_SCHEMA,
                              │                        classifyRoom, passesGate
                              └──> src/lib/local-llm.ts ──HTTP──> LM Studio
                                     (askLocal, 127.0.0.1:1234/v1)

both scripts ──> src/lib/tagging-run.ts   classifyFailure: abort vs skip, and the
                                          shared consecutive-failure breaker
both scripts ──> src/lib/args.ts          parseUnitInterval, parsePositiveNumber
tag-bench.ts ──> src/lib/bench-report.ts  renderReport (pure, unit-tested)

scripts/tag-auto.ts  ──> src/db/queries/tags.ts  listUntaggedImages,
                                                 setImageTagIfAbsent, propertyHasImages
scripts/tag-bench.ts ──> src/db/queries/tags.ts  listTaggedImages,
                                                 topTaggedProperties  (read-only)
```

`ROOM_PROMPT` lives in `room-classify.ts`, not in `local-llm.ts` — the transport
knows nothing about rooms. A Phase 2 text job reuses `askLocal` directly and
defines its own prompt constant alongside it.

### `src/lib/local-llm.ts` — the local-model layer

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

- Property selection: `--properties=<id,id,...>`, a comma-separated list — NOT a
  repeatable `--property=`, because `parseFlags` cannot represent a repeated flag
  without changing its return type and every existing caller's narrowing. The
  singular spelling is rejected outright rather than ignored. With none given, the
  10 properties with the most tagged photos, which measured at 445 photos.
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
- `confidence >= threshold` → `setImageTagIfAbsent({ imageId, roomType, confidence,
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
2. `src/lib/local-llm.ts` + the `listTaggedImages` query.
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
- A concurrent request pool. Add it when 445 sequential images takes long enough
  to be annoying, which is a measurement, not a prediction.

## Benchmark result (2026-07-31)

Model `qwen/qwen3-vl-8b`, images converted to JPEG at long edge 1024, ~1s/photo.

**The central assumption of this design was wrong.** The trust model assumed a
confidence gate would separate reliable answers from unreliable ones. It does
not: the model returns ≥0.95 on 98% of photos *including every one it gets
wrong*. Measured over 118 photos, every threshold from 0.70 to 0.95 auto-tags
100% of images with an identical error count. `--threshold` is retained only as
a guard against a typo'd invocation.

**Recorded value: `--threshold=0.8`** (2026-08-13). Any value in 0.70–0.95 is
byte-for-byte equivalent, so this is a convention, not a tuned parameter — it
exists so runs stop re-deriving a number that provably does not matter. Do not
spend a 20–60 minute benchmark picking a different one.

| | First run | + prompt/vocab fixes | + branding sweep |
| --- | --- | --- | --- |
| Agreement with hand tags | 84.5% | 93.2% | **95.8%** |
| Error rate at any threshold | 15.5% | 6.8% | **4.2%** |
| `dining` recall | 42.9% | 71.4% | 71.4% |
| `aerial` | did not exist | 12/12 | 12/12 precision and recall |
| `exclude` | did not exist | 0/3 | 3/3 precision and recall |

Each improvement came from correcting *our own* inputs, not from touching the
model. `exclude` going 0/3 → 3/3 is the clearest case: the model had been right
all along and the ground truth was stale.

The residual 4.2% is concentrated in one cluster — `living` over-predicted
against `dining` (2), plus single `exterior`/`other` boundary cases. `bedroom`,
`bathroom`, `aerial` and `exclude` are perfect on this sample.

**Diagnosing the first run's 18 disagreements found only 2 genuine model
errors.** The rest were our own prompt and a vocabulary that was too narrow:

- 6 were annotated locality maps, which our prompt sent to `other` and the
  human had tagged `exterior` — neither was right, hence the new `aerial` type.
- 6 were hallways, landings and staircases, which had no category at all.
- 3 were genuine open-plan shots where the prompt's own rule says `living`.
- 2 were the real defect: the model answered `living` for kitchen-plus-dining
  shots with no lounge in frame. The prompt now requires a visible lounge.

The lesson worth keeping: a benchmark that scores a model against human labels
measures *agreement between the prompt and the labelling convention*, not model
competence. Read the disagreements before concluding anything about the model.

**Decision:** accept ~7% and correct in the app rather than gate harder. Per-class
precision is the real signal if gating is ever revisited — `bedroom`, `bathroom`,
`exterior`, `aerial` and `dining` all measured 100%, while `living` (86%) and the
`other`/`exclude` boundary carry nearly all the error.

## Known follow-ups

Findings raised during implementation review and deliberately deferred, each with
the ruling. Recorded here because the execution ledger lives in a gitignored
scratch directory and does not survive the merge.

**Do before the first real run**

- **Smoke-test with `--limit=5` before the full 445.** No code on this branch has
  ever exchanged a byte with a real vision model — only with stubs. The failure
  modes cluster at the first call: image format, model id, whether the loaded model
  honours JSON-schema-constrained output. Five photos costs a minute and tells you
  whether a 20-60 minute run is worth starting.
- **418 of the 445 sample files are `.webp` and 5 are `.gif`.** If the model's
  vision stack rejects webp, every photo errors and the breaker aborts at 10 with a
  model-flavoured message. "All photos error immediately" means image format, not a
  bad threshold.
- **Do not read `0 of those wrong (0.0% error rate)` as proven-safe.** The 445
  photos come from only 10 properties and are therefore correlated; a zero-wrong
  bucket is compatible with a true error rate above 1%, which is thousands of wrong
  tags at library scale. Treat a zero-wrong bucket as "below roughly 1%".

**Deferred with rulings**

- **`--properties=` and bare `--properties` fall back to the default sample
  instead of failing.** Same silent-widening class as the guard added for the
  empty-list case, and inconsistent with `src/lib/args.ts`, which rejects empty
  values for every other flag. Read-only, costs a 20-60 minute run on a sample you
  did not ask for. Pre-existing, not a regression. Ruling: real, deferred.
- **`src/lib/tagging-run.ts` has no test coverage.** Deleting its
  unreadable-image classification — the entirety of one review fix — leaves the
  whole suite green. The producer-side message texts *are* pinned, which is why
  this is not worse, but this module now decides abort-vs-skip for both scripts and
  is precisely the divergence-prone code that sharing was meant to protect. Roughly
  eight lines of pure-function assertions would close it. Ruling: real, deferred,
  highest-value item on this list.
- **`tag-auto`'s circuit breaker has no automated test.** Deferred by decision
  during execution; partly mitigated now that both scripts share one breaker.
- **`propertyHasImages` answers "has images", not "is a real id".** A freshly
  ingested property with no images yet would still be reported as a bad id. The
  repo's existing convention (`SELECT 1 FROM properties WHERE id = ?`) is the right
  probe. Ruling: cosmetic today.
- **`tag-bench` opens the DB before validating flags** (static import), so a bad
  flag touches `data/app.db` before exiting. `tag-auto` uses a dynamic import
  specifically to avoid this. Harmless on a current-schema DB. Ruling: consistency
  wart, deferred.
- **`image_tags.room_type` has no CHECK constraint** and `listTaggedImages` casts
  it to a typed union without validating. The live DB is clean (7 distinct values,
  all in vocabulary, no NULLs), and the failure mode is benign — an off-vocabulary
  row makes measured agreement *pessimistic*, biasing the threshold toward caution.
  A DDL migration on a tracked 9MB binary is not worth it for this.
- **Report cosmetics:** empty confidence buckets are suppressed with no total
  printed; the confusion matrix has row totals but no column totals.
- **`--from-jsonl` to re-render an aborted benchmark.** Genuine YAGNI until a run
  actually aborts partway; rendering the report before exit already covers the
  common case.

**Structural facts worth remembering**

- **`src/db/client.ts` runs the DDL, `migrateColumns`, and a WAL pragma on every
  connection open.** So any script that merely *reads* the database rewrites its
  bytes, and `data/app.db` is a **tracked** file. A clean `git status` is therefore
  not proof that a read-only script stayed read-only — the proof is a before/after
  `tagStatus()` comparison.
- **`/data/` is commented out in `.gitignore`.** 8,331 files under `data/` are
  tracked, including `app.db` and `claude-credentials.md`. Only the WAL sidecars
  and `data/_tagbench.jsonl` are ignored.
- **`notes='local:<model>'` is not durable provenance.** `scripts/hero-set.ts`
  overwrites `notes` with `'hero'`, and `setImageTag` nulls `notes` when a caller
  omits it — so `tag:set` on a hero image erases its marker too. `tagged_by =
  'local-vlm'` is the more reliable handle, and there is no sanctioned command to
  list or revert local-vlm tags; that would be raw SQL today.
- **`npm test` is not fully hermetic** (pre-existing): `test/units.test.ts` imports
  `src/db/queries/properties`, which opens the real `data/app.db` at module scope.
  Every other DB-touching test sets `DB_PATH` to a temp copy. This branch's own
  tests are correctly sandboxed.
