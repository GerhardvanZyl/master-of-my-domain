// The "does this property page render a floorplan?" sweep, shared by
// scripts/floorplan-coverage.ts (--fast and the full pass) and
// scripts/_verify-live.mjs. No entry point: importing it starts nothing.
//
// Why this is .mjs and separate from scripts/lib/floorplan-recover.ts, which
// owns the rest of the floorplan logic: _verify-live.mjs runs under plain
// `node`, not tsx, so it cannot import a .ts module. (floorplan-recover.ts
// used to pull in src/db/queries/properties.ts, which opens and migrates the
// local data/app.db as an import-time side effect; that coupling has since
// been removed, but the runtime split below stands on its own regardless.)
// The split is along the runtime boundary and the concern boundary at once:
// this file is the page sweep, that one is hero resolution and classification.
//
// It is NOT in _live-http.mjs because ">Floorplan<" is floorplan domain
// knowledge and that module is the generic live-state reader.
import { mapLimit } from "../_live-http.mjs";

/** The marker src/app/property/[id]/page.tsx renders for a floorplan block. */
export const FLOORPLAN_MARKER = ">Floorplan<";

/**
 * @template {{ id: string }} T
 * @typedef {object} FloorplanScan
 * @property {T[]} missing Pages that answered and carried no floorplan block, in input order.
 * @property {number} scanned Pages that answered at all: `scanned + errors.length === targets.length`.
 * @property {{ id: string, error: string }[]} errors Pages that could not be read — UNKNOWN, not "has one".
 */

/**
 * Fetches every property page and tests for the floorplan block.
 *
 * A page that fails to load is recorded in `errors` and never thrown out of
 * here. Both callers treat this sweep as informational, and in
 * _verify-live.mjs it runs ahead of every blocking check and the report
 * itself — one delisted row or one container restart must not discard those.
 *
 * @template {{ id: string }} T
 * @param {string} base
 * @param {readonly T[]} targets
 * @param {{ concurrency?: number, onProgress?: (scanned: number, total: number) => void }} [opts]
 * @returns {Promise<FloorplanScan<T>>}
 */
export async function scanRenderedFloorplans(base, targets, opts = {}) {
  /** @type {{ id: string, error: string }[]} */
  const errors = [];
  let done = 0;
  const hasFloorplan = await mapLimit(targets, opts.concurrency ?? 6, async (t) => {
    try {
      const res = await fetch(`${base}/property/${t.id}`);
      if (!res.ok) throw new Error(`property/${t.id} -> HTTP ${res.status}`);
      return (await res.text()).includes(FLOORPLAN_MARKER);
    } catch (e) {
      errors.push({ id: t.id, error: e.message });
      return null;
    } finally {
      opts.onProgress?.(++done, targets.length);
    }
  });
  // Indexed rather than pushed from the workers, so the list is in input
  // order and the report stays diffable round over round.
  return {
    missing: targets.filter((_, i) => hasFloorplan[i] === false),
    scanned: targets.length - errors.length,
    errors,
  };
}
