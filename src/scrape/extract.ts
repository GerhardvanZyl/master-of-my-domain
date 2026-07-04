import type { Page } from "playwright-core";

/** Parse the `#__NEXT_DATA__` script tag, or null if absent/unparseable. */
export async function readNextData(page: Page): Promise<unknown | null> {
  const txt = await page
    .$eval("#__NEXT_DATA__", (el) => el.textContent)
    .catch(() => null);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** Parse all `<script type="application/ld+json">` blocks (flattened). */
export async function readJsonLd(page: Page): Promise<unknown[]> {
  const blocks = await page
    .$$eval('script[type="application/ld+json"]', (els) =>
      els.map((e) => e.textContent ?? ""),
    )
    .catch(() => [] as string[]);
  const out: unknown[] = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      /* ignore malformed block */
    }
  }
  return out;
}

/** Deep-walk any JSON value, collecting values whose key matches a predicate. */
export function deepCollect(
  root: unknown,
  keyMatch: (key: string) => boolean,
): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
    } else {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (keyMatch(k)) out.push(v);
        stack.push(v);
      }
    }
  }
  return out;
}

/**
 * Deep-walk collecting image URL strings whose hostname matches `hostRe`,
 * preserving first-seen order and de-duplicating.
 */
export function collectImageUrls(root: unknown, hostRe: RegExp): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [root];
  const visited = new Set<unknown>();
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === "string") {
      if (
        hostRe.test(node) &&
        /\.(jpe?g|png|webp)(\?|$)/i.test(node) &&
        !seen.has(node)
      ) {
        seen.add(node);
        found.push(node);
      }
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);
    const values = Array.isArray(node)
      ? node
      : Object.values(node as Record<string, unknown>);
    // push in reverse so first-seen order is preserved with a LIFO stack
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }
  return found;
}

/** First non-empty value returned by any deep key in `keys`. */
export function firstDeep(
  root: unknown,
  keys: string[],
): unknown {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  const vals = deepCollect(root, (k) => set.has(k.toLowerCase()));
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return undefined;
}
