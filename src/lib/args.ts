/** Parse `--key=value`, `--key value`, and bare `--flag` from argv. */
export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[body] = argv[++i];
    } else {
      out[body] = true;
    }
  }
  return out;
}

/**
 * Strict flag parsers shared by scripts that gate real work on a numeric
 * flag (tag:bench's --count/--limit, tag:auto's --threshold/--limit). A
 * garbage value here must fail loudly rather than silently degrade to "no
 * limit" or "gate at 0" — that was bug M7, twice (tag-bench.ts, then
 * tag-auto.ts), so the parsing lives here once instead of being copied.
 */

/**
 * Parses `raw` as a positive number. Returns `undefined` if the flag was not
 * passed at all — that's a legitimate "no limit". Throws if the flag WAS
 * passed but is not a well-formed positive number: a bare flag (`true`),
 * empty/whitespace string, non-numeric, zero, negative, NaN, or Infinity.
 */
export function parsePositiveNumber(
  raw: string | boolean | undefined,
  flagName: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid --${flagName}=${JSON.stringify(raw)} — expected a positive number.`,
    );
  }
  return n;
}

/**
 * Parses `raw` as a number in [0, 1] inclusive. Unlike parsePositiveNumber,
 * this flag is mandatory for its callers — a missing value throws the same
 * as a malformed one, since there is deliberately no default for a
 * confidence gate. 0 and 1 are valid, legitimate boundary values and must be
 * accepted, not treated as falsy/missing.
 */
export function parseUnitInterval(
  raw: string | boolean | undefined,
  flagName: string,
): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(
      `Invalid --${flagName}=${JSON.stringify(raw)} — expected a number between 0 and 1.`,
    );
  }
  return n;
}
