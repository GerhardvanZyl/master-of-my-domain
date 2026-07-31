/**
 * Shared between tag-bench.ts and tag-auto.ts: classifying a classifyRoom()
 * failure for the circuit breaker, and the periodic progress/ETA line. Both
 * scripts loop over classifyRoom() results almost identically; keeping this
 * logic in one place means a fix (like the unreadable-image exclusion below)
 * can't be made in one script and forgotten in the other, which is exactly
 * how that bug happened the first time.
 */

/**
 * - "not-reachable": the model server itself is down — the whole run should
 *   abort, not grind through the rest of the sample one error at a time.
 * - "ffmpeg-missing": ffmpeg is not on PATH — a fatal run-level configuration
 *   problem (image-prep.ts can't convert anything without it), not a
 *   per-photo one. Aborts immediately, same as a dead server, but is a
 *   distinct diagnosis so the operator knows to install ffmpeg rather than
 *   check whether LM Studio is running.
 * - "unreadable-image": a missing/pruned file on disk, or one that ffmpeg
 *   itself could not convert — a per-photo data problem, not evidence the
 *   model is unwell. Counts toward the errored total but must NOT advance
 *   the consecutive-failure counter, or a property with 10 pruned photos
 *   would trip the breaker for no model-side reason.
 * - "other": any other per-photo failure (bad reply, timeout, HTTP error) —
 *   counts toward the errored total AND the consecutive-failure counter.
 */
export type FailureKind =
  | "not-reachable"
  | "ffmpeg-missing"
  | "unreadable-image"
  | "other";

export function classifyFailure(message: string): FailureKind {
  if (/not reachable/i.test(message)) return "not-reachable";
  if (/ffmpeg is required/i.test(message)) return "ffmpeg-missing";
  if (/Could not read image at/i.test(message)) return "unreadable-image";
  return "other";
}

/** Consecutive "other" failures before the circuit breaker trips. */
export const CONSECUTIVE_FAILURE_LIMIT = 10;

/** The message both scripts print when the breaker trips. */
export function circuitBreakerMessage(consecutiveFailures: number): string {
  return `Aborting: ${consecutiveFailures} consecutive failures — is the model still loaded and vision-capable?`;
}

/** True every 25th photo (1-indexed) — when a progress line should print. */
export function shouldReportProgress(i: number): boolean {
  return (i + 1) % 25 === 0;
}

/** The `…N/total (Xs/photo, ~Ymin left)` progress line both scripts print. */
export function progressLine(
  i: number,
  total: number,
  startedMs: number,
): string {
  const rate = (Date.now() - startedMs) / 1000 / (i + 1);
  return `  …${i + 1}/${total} (${rate.toFixed(1)}s/photo, ~${Math.round(
    (rate * (total - i - 1)) / 60,
  )}min left)`;
}
