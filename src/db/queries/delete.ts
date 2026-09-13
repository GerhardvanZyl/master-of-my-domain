import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../client";
import { properties, scrapeJobs } from "../schema";
import { IMAGES_DIR } from "@/lib/env";

/**
 * Delete a property: detach its scrape_jobs rows (the one FK to properties
 * with no ON DELETE action — every other child table cascades, see ddl.ts),
 * delete the row itself, then remove its image directory. The two DB
 * statements run in one transaction — a half-deleted property (row gone but
 * job rows still pointing at it, or vice versa) is worse than no delete at
 * all. Idempotent: an id matching no row deletes nothing (`deleted: false`),
 * not a throw — callers re-sending the same batch must not see an error. That
 * is not the same as a no-op: the filesystem step below still runs and can
 * still remove a stale `IMAGES_DIR/<id>` left over from a prior failure.
 *
 * The filesystem step is deliberately outside the transaction and can never
 * roll it back: the DB row is the source of truth, an orphaned image
 * directory is recoverable, a half-deleted DB is not. A removal failure is
 * returned rather than thrown, so a locked/missing directory doesn't turn an
 * otherwise-successful delete into an error.
 *
 * The filesystem step runs UNCONDITIONALLY, even when no row was deleted: a
 * re-send after a prior removal failure finds the ref already gone
 * (`deleted: false`), and if the fs step only ran on `deleted: true` a
 * failed-then-retried removal could never actually clear the orphan --
 * `force: true` makes a miss on an already-clean directory a no-op.
 */
export function deleteProperty(id: string): { deleted: boolean; imageDirError?: string } {
  const deleted = sqlite.transaction(() => {
    db.update(scrapeJobs).set({ propertyId: null }).where(eq(scrapeJobs.propertyId, id)).run();
    return db.delete(properties).where(eq(properties.id, id)).run().changes > 0;
  })();

  // id comes from a request param upstream. The guard must prove the target
  // IS the literal directory named `id`, not merely that it resolves to
  // SOMEWHERE under IMAGES_DIR -- a containment check (comparing
  // `dirname(resolved)` to `root`, or a `startsWith(root + sep)` prefix test)
  // is not enough: on Windows an 8.3 short name (`PROP_A~1`), a case-only
  // variant, and the NTFS `<id>::$INDEX_ALLOCATION` stream form all resolve
  // to a path whose dirname IS `root` while never being `id` itself, and
  // `sub/../<id>` collapses to `root/<id>` before either check ever runs.
  // Requiring `id` to be a byte-exact entry of `root`'s own listing rules out
  // every alias at once: a literal listing entry is a direct child by
  // construction, so identity subsumes containment. `basename(id) !== id`
  // stays first as a cheap pre-reject (kills `.`, `..`, and anything with a
  // separator) so obvious junk never costs a `readdirSync`. A missing or
  // unreadable IMAGES_DIR means there is nothing to remove, not an error --
  // this must never throw out of deleteProperty. `fs.rm({recursive: true})`
  // is not a forgiving primitive.
  const root = path.resolve(IMAGES_DIR);
  if (path.basename(id) !== id) return { deleted };
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { deleted };
  }
  if (!entries.includes(id)) return { deleted };
  const dir = path.join(root, id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted };
  } catch (e) {
    return { deleted, imageDirError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Batch delete-by-reference, shared by the HTTP /api/batch `delete` section.
 * No CLI mirrors this one (see the route's doc comment for why) — writing
 * `data/app.db` directly is banned by standing rule, so HTTP is the only
 * write path that matters here.
 *
 * Deletes by explicit reference only — an id or listing_url the caller named
 * — never by heuristic match. `scripts/_hnl-remove.mjs` skips rows carrying
 * ratings/notes because it matches by guessed address; that guard would only
 * make an explicit delete request fail silently here, so there isn't one.
 *
 * ponytail: a `listingUrls` ref matches `listing_url` ONLY, deliberately
 * unlike `sold`/`withdrawn`/`priceObserve`, which resolve `listing_url` OR
 * `alt_listing_url` via `findProperty` in status.ts. `listing_url` is UNIQUE,
 * so at most one row can ever match -- no ambiguity is possible. Resolving a
 * DESTRUCTIVE reference through an alias cannot be made idempotent: after a
 * successful delete, a re-send of the exact same ref can match a different
 * row (one that only ever carried it as `alt_listing_url`) and destroy that
 * one too -- a second, different property destroyed by "simply re-sending a
 * failed batch", which is the endpoint's whole recovery story. A status mark
 * is recoverable if it lands on the wrong row; a delete is not. A caller
 * holding only an REA (alt) URL should pass the property `id`, or its
 * canonical `listing_url`, instead.
 *
 * Idempotent: a ref matching no row lands in `notFound`, not an exception --
 * a failed batch is simply re-sent. `ids` are processed before `listingUrls`
 * per ref list; the two lists are otherwise independent and a property named
 * by both is simply deleted once (the second reference resolves to nothing).
 *
 * An `ids` ref calls deleteProperty() directly, with NO pre-check SELECT: the
 * ref already IS the property id, and a pre-check would report a re-sent
 * (already-deleted) id as notFound and skip the call entirely -- exactly the
 * bug that let a re-send never retry a failed image-directory removal, since
 * deleteProperty's own fs step (see above) never ran a second time. A
 * `listingUrls` ref has no such shortcut: deleteProperty needs an id, and
 * once a row is gone there is no longer anywhere to resolve its URL to one --
 * that mapping lived only in the deleted row -- so a URL-addressed re-send
 * cannot retry a failed removal the way an id-addressed one can.
 *
 * `ids`/`listingUrls` are typed `unknown[]` on purpose: this is the one
 * section whose per-item shape isn't otherwise validated before reaching SQL.
 * A non-array reports one `errors` entry naming its `typeof` and is treated
 * as empty (rather than, say, iterated as a string's characters); a non-string
 * element is reported the same way. `typeof`, not `String(x)`: stringifying an
 * arbitrary value can itself throw (`Cannot convert object to primitive
 * value` for a JSON-constructible object whose `toString` is shadowed by a
 * non-callable value), and that throw would escape this function -- an
 * unhandled 500 discarding every later section of the payload, the exact hole
 * the bad-shape check exists to close. Every per-ref failure -- a bad-shape
 * element or an unexpected throw out of deleteProperty -- is caught here and
 * returned in `errors`, never left to propagate out of this function.
 */
export function deletePropertiesByRef(input: {
  ids?: unknown;
  listingUrls?: unknown;
}): { deleted: number; notFound: string[]; errors: { ref: string; error: string }[] } {
  const byUrl = sqlite.prepare("SELECT id FROM properties WHERE listing_url = ?");

  let deleted = 0;
  const notFound: string[] = [];
  const errors: { ref: string; error: string }[] = [];

  const stringRefs = (v: unknown): string[] => {
    if (!Array.isArray(v)) {
      if (v !== undefined) errors.push({ ref: typeof v, error: "ids/listingUrls must be an array" });
      return [];
    }
    const out: string[] = [];
    for (const x of v) {
      if (typeof x === "string") out.push(x);
      else errors.push({ ref: typeof x, error: "ref must be a string" });
    }
    return out;
  };

  // Runs deleteProperty(id) and files the outcome under `ref` -- `ref` and
  // `id` differ only for a listingUrls entry, where the caller named the
  // property by URL but deleteProperty needs its id.
  const runById = (ref: string, id: string) => {
    try {
      const res = deleteProperty(id);
      if (res.deleted) deleted++;
      else notFound.push(ref);
      if (res.imageDirError) errors.push({ ref, error: `image directory not removed: ${res.imageDirError}` });
    } catch (e) {
      errors.push({ ref, error: e instanceof Error ? e.message : String(e) });
    }
  };

  for (const id of stringRefs(input.ids)) runById(id, id);

  for (const url of stringRefs(input.listingUrls)) {
    const row = byUrl.get(url) as { id: string } | undefined;
    if (row) runById(url, row.id);
    else notFound.push(url);
  }

  return { deleted, notFound, errors };
}
