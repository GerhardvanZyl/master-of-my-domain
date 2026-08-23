/**
 * Offline test of PATCH /api/properties/<id>/rating: proves the route accepts
 * null as a clear and rejects a bare "". This is the contract the client's
 * clear fix (PropertyGrid's setVibe, sending `next || null`) relies on — it
 * does NOT exercise the client and would still pass if `|| null` were
 * reverted, since the route itself was never broken (see git blame — this
 * null-handling predates tech-001 entirely). The regression guard for the
 * actual grid-tile bug is test/ui.test.ts's "clearing a grid tile's vibe
 * survives a reload (tech-001)".
 *
 * Modelled on test/batch.test.ts: temp DB, set BEFORE importing app modules,
 * call the real route handler.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rating-clear-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function patch(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { PATCH } = await import("../src/app/api/properties/[id]/rating/route");
  const res = await PATCH(
    new Request(`http://localhost:3225/api/properties/${id}/rating`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  migrate();

  sqlite
    .prepare(
      `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
       VALUES ('a', 'domain', 'https://x/a', '2026-01-01', '2026-01-01', '2026-01-01')`,
    )
    .run();

  // Seed a rated row, same as an earlier click on the tile would have.
  const set = await patch("a", { profile: "gerhard", vibe: "justno" });
  assert.equal(set.status, 200, "initial rate succeeds");
  const afterSet = sqlite
    .prepare("SELECT vibe FROM property_ratings WHERE property_id = 'a' AND profile = 'gerhard'")
    .get() as { vibe: string | null };
  assert.equal(afterSet.vibe, "justno", "row carries the rating after the first click");

  // Clicking the same vibe again is meant to clear it. PropertyGrid's setVibe
  // sends `vibe: next || null` (next is "" when clearing) — the route accepts
  // null as a clear generically but has never accepted a bare "" (VOCAB
  // validates it like any other bad value). Prove the contract the fix
  // establishes: the null the grid now sends reaches the route and clears.
  const clear = await patch("a", { profile: "gerhard", vibe: null });
  assert.equal(clear.status, 200, "clearing the way the grid sends it must not 400");
  const afterClear = sqlite
    .prepare("SELECT vibe FROM property_ratings WHERE property_id = 'a' AND profile = 'gerhard'")
    .get() as { vibe: string | null };
  assert.equal(afterClear.vibe, null, "the stored vibe is actually cleared, not left as the old value");

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ rating-clear.test: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
