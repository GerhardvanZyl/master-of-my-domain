/**
 * Tests for scripts/_pass-apply-live.mjs's pure gallery-building helpers —
 * root causes 1 and 2 of run 20261003-1801-fix-domain-floorplans-heroes:
 * Domain floorplans are commonly 1200x1200, so the old shape filter dropped
 * them as "agent cards/logos" (root cause 1), and a listing that already had
 * photos never got a floorplan added later because the whole gallery was
 * skipped once image_count > 0 (root cause 2).
 *
 * The script had no `main()` — every line ran at module scope on import — so
 * it was refactored (no behaviour change) to export these pure helpers behind
 * an isMain guard, same pattern as scripts/_tag-remote.ts and
 * scripts/_hero-sync-live.mjs (conventions.md: "a script with an
 * unconditional main() at module scope is unsafe to import from").
 */
import assert from "node:assert";

async function main() {
  const { renderable, buildGalleryEntry } = await import("../scripts/_pass-apply-live.mjs");

  // A real Domain floorplan basename, square (w=h=1200) — the exact shape
  // root cause 1 discarded as an agent card/logo before this fix.
  const floorplanSquareUrl = "https://rimh2/x/2030000001_1_3_260101_99-w1200-h1200.jpg";
  // Same square dimensions, but crop `_1_` (a photo, not a floorplan) — must
  // still be dropped, proving the bypass is keyed on the `_3_` crop and not
  // just "any square image now passes".
  const photoSquareUrl = "https://rimh2/x/2030000001_2_1_260101_99-w1200-h1200.jpg";
  // An ordinary landscape photo.
  const photoLandscapeUrl = "https://rimh2/x/2030000001_3_1_260101_99-w1600-h1067.jpg";

  // --- 1. shape filter: a square `_3_` basename is kept ---
  const squareKeptMsg =
    "REGRESSION GUARD (root cause 1): a square (1200x1200) `_3_` floorplan basename " +
    "must bypass the aspect filter and be kept";
  assert.equal(renderable(floorplanSquareUrl), true, squareKeptMsg);

  // --- 2. shape filter: a square NON-`_3_` basename is still dropped ---
  const squareDroppedMsg =
    "a square `_1_` (photo) basename at the same dimensions is still dropped as an agent " +
    "card/logo -- the bypass is basename-keyed, not aspect-keyed";
  assert.equal(renderable(photoSquareUrl), false, squareDroppedMsg);

  // --- 3. a listing that ALREADY HAS photos yields a floorplan-only entry ---
  // REGRESSION GUARD (root cause 2): before this fix, image_count > 0 skipped
  // the listing entirely (reported under skippedHavePhotos) and the floorplan
  // was never added. imageUrls must equal floorplanUrls -- only the `_3_`
  // urls -- and must NOT include the already-stored photo.
  {
    const entry = buildGalleryEntry("https://www.domain.com.au/1-fp-st", 5, [
      photoLandscapeUrl,
      floorplanSquareUrl,
    ]);
    assert.ok(entry, "a listing with photos but a new floorplan this capture must NOT be skipped");
    assert.deepEqual(
      entry.imageUrls,
      [floorplanSquareUrl],
      "imageUrls for a floorplan-only entry holds ONLY the `_3_` url(s)",
    );
    assert.deepEqual(
      entry.floorplanUrls,
      [floorplanSquareUrl],
      "floorplanUrls equals imageUrls exactly for a floorplan-only entry",
    );
    const noResendMsg =
      "the already-stored photo must NOT be re-sent -- re-sending it would duplicate the " +
      "gallery (syncImages re-signed-URL dedup)";
    assert.ok(!entry.imageUrls.includes(photoLandscapeUrl), noResendMsg);
  }

  // --- 4. a listing that already has photos and NO new floorplan is still skipped (unchanged) ---
  {
    const entry = buildGalleryEntry("https://www.domain.com.au/2-fp-st", 5, [photoLandscapeUrl]);
    const stillSkippedMsg =
      "a listing with photos and no `_3_` image this capture returns null (caller reports " +
      "skippedHavePhotos), preserving the pre-existing behaviour";
    assert.equal(entry, null, stillSkippedMsg);
  }

  // --- 5. a ZERO-photo listing's full gallery carries floorplanUrls ---
  {
    const entry = buildGalleryEntry("https://www.domain.com.au/3-fp-st", 0, [
      photoLandscapeUrl,
      floorplanSquareUrl,
    ]);
    assert.ok(entry, "a zero-photo listing always yields an entry");
    assert.ok(
      entry.imageUrls.includes(photoLandscapeUrl) && entry.imageUrls.includes(floorplanSquareUrl),
      "the full gallery contains both the photo and the floorplan",
    );
    assert.deepEqual(
      entry.floorplanUrls,
      [floorplanSquareUrl],
      "floorplanUrls correctly identifies the `_3_` subset of the full gallery",
    );
  }

  console.log("✓ pass-apply-live.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ pass-apply-live.test FAILED:", e);
  process.exit(1);
});
