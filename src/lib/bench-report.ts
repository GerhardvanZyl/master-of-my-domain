import { ROOM_TYPES, type RoomType } from "@/db/schema";

/**
 * Pure report rendering for tag:bench, split out of the CLI so the arithmetic
 * — precision/recall, confidence buckets, threshold table — has a test seam.
 * No I/O here: this module never touches the DB, the filesystem, or stdio.
 */

export interface BenchRow {
  imageId: string;
  truth: RoomType;
  got: RoomType;
  confidence: number;
  /**
   * "model": a real vision-model verdict. "rule": a deterministic verdict
   * (SVG -> exclude) made without calling the model at all. Undefined is
   * treated as "model" for backward compatibility. Rule-tagged rows are
   * excluded from every figure below (overall agreement, confusion matrix,
   * precision/recall, confidence buckets, threshold table) — the rule is
   * right 100% of the time by construction, so folding it in would inflate
   * the number a human picks a --threshold from. They're reported on their
   * own line instead.
   */
  source?: "model" | "rule";
}

export interface BenchMeta {
  model: string;
  /** Wall-clock time spent classifying, in ms. */
  elapsedMs: number;
  /** Where raw per-photo rows were appended. */
  outPath: string;
  /** Number of distinct properties the sample was drawn from. */
  propertyCount: number;
  /** Number of photos matched for this run (reflects --limit, if given). */
  photoCount: number;
  /** The --limit flag's value, if the caller passed one. */
  limit?: number;
  /** The raw --properties flag value, if the caller passed one. */
  propertiesFlag?: string;
  /** ISO timestamp for when the run started. */
  timestamp: string;
  /**
   * The --max-edge value images were downscaled to before being sent to the
   * model. A report compared across runs is meaningless without this — a
   * smaller edge is faster but can change accuracy.
   */
  maxEdge?: number;
  /** True if the run stopped before processing the full sample. */
  aborted?: boolean;
  /** Human-readable reason for an early abort. */
  abortReason?: string;
}

const W = 10;

/** `d === 0` reports "n/a" rather than a NaN%. */
export function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

/** Percentage only (no n/d), for spots where the count is already shown separately. */
function rate(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

export function renderReport(
  rows: BenchRow[],
  failed: number,
  meta: BenchMeta,
): string {
  const lines: string[] = [];
  const attempted = rows.length + failed;
  const modelRows = rows.filter((r) => r.source !== "rule");
  const ruleRows = rows.filter((r) => r.source === "rule");

  lines.push(`\nModel:  ${meta.model}`);
  lines.push(`Run:    ${meta.timestamp}`);
  lines.push(
    `Sample: ${meta.photoCount} photo(s) from ${meta.propertyCount} propert${
      meta.propertyCount === 1 ? "y" : "ies"
    }` +
      (meta.propertiesFlag ? ` (--properties=${meta.propertiesFlag})` : "") +
      (meta.limit !== undefined ? `, --limit=${meta.limit} applied` : ""),
  );
  lines.push(`Photos: ${rows.length} classified, ${failed} errored`);
  lines.push(`Time:   ${(meta.elapsedMs / 1000 / 60).toFixed(1)} min`);
  if (meta.maxEdge !== undefined) {
    lines.push(`--max-edge=${meta.maxEdge} (long edge cap in px sent to the model)`);
  }
  if (ruleRows.length > 0) {
    lines.push(
      `Rule-tagged (SVG → exclude): ${ruleRows.length} photos, not included in the figures below`,
    );
  }

  if (meta.aborted) {
    lines.push(
      `\n*** RUN ABORTED EARLY${meta.abortReason ? `: ${meta.abortReason}` : ""} ***`,
    );
    lines.push(
      `*** Report below reflects only the ${attempted} photo(s) attempted, not the full ${meta.photoCount}-photo sample. ***`,
    );
  }

  if (attempted > 0 && failed / attempted > 0.2) {
    lines.push(
      `\n*** WARNING: ${rate(failed, attempted)} of attempted photos failed (${failed}/${attempted}) — this sample may not be representative. ***`,
    );
  }

  const agreed = modelRows.filter((r) => r.truth === r.got).length;
  lines.push(`\nOverall agreement with your tags: ${pct(agreed, modelRows.length)}`);

  lines.push("\nConfusion — row = your tag, column = model's tag");
  lines.push(
    "".padEnd(W) +
      ROOM_TYPES.map((r) => r.slice(0, 8).padStart(W)).join("") +
      "total".padStart(W),
  );
  for (const truth of ROOM_TYPES) {
    const row = modelRows.filter((r) => r.truth === truth);
    lines.push(
      truth.padEnd(W) +
        ROOM_TYPES.map((got) =>
          String(row.filter((r) => r.got === got).length).padStart(W),
        ).join("") +
        String(row.length).padStart(W),
    );
  }

  lines.push("\nPer-room precision / recall");
  for (const room of ROOM_TYPES) {
    const tp = modelRows.filter((r) => r.truth === room && r.got === room).length;
    const predicted = modelRows.filter((r) => r.got === room).length;
    const actual = modelRows.filter((r) => r.truth === room).length;
    lines.push(
      `  ${room.padEnd(9)} precision ${pct(tp, predicted).padEnd(18)} recall ${pct(tp, actual)}`,
    );
  }

  lines.push("\nAgreement by the model's own confidence");
  // NB: the 1.01 upper bound on the top bucket is load-bearing — it keeps
  // confidence === 1.0 from falling out of every bucket. Do not "fix" it.
  const buckets: [number, number, string][] = [
    [0.95, 1.01, "0.95+"],
    [0.9, 0.95, "0.90–<0.95"],
    [0.8, 0.9, "0.80–<0.90"],
    [0.7, 0.8, "0.70–<0.80"],
    [0, 0.7, "<0.70"],
  ];
  for (const [lo, hi, label] of buckets) {
    const b = modelRows.filter((r) => r.confidence >= lo && r.confidence < hi);
    if (b.length === 0) continue;
    const ok = b.filter((r) => r.truth === r.got).length;
    lines.push(
      `  conf ${label.padEnd(11)}  n=${String(b.length).padStart(4)}  agreement ${pct(ok, b.length)}`,
    );
  }

  lines.push("\nWhat tag:auto would have done at each threshold");
  for (const t of [0.7, 0.8, 0.85, 0.9, 0.95]) {
    const auto = modelRows.filter((r) => r.confidence >= t);
    const ok = auto.filter((r) => r.truth === r.got).length;
    const wrong = auto.length - ok;
    lines.push(
      `  --threshold=${t.toFixed(2)}  auto-tags ${pct(auto.length, modelRows.length)}` +
        `, ${wrong} of those wrong (${rate(wrong, auto.length)} error rate)` +
        `, ${modelRows.length - auto.length} queued for review`,
    );
  }
  lines.push(`\nRaw rows appended to ${meta.outPath}`);

  return lines.join("\n");
}
