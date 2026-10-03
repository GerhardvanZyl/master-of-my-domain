/**
 * Regression tests for scripts/_tag-remote.ts, run
 * 20261003-1801-fix-domain-floorplans-heroes.
 *
 * Root cause 5: the floorplan mark used to require the LAST image to
 * classify as "other" -- a position heuristic that could put notes='hero' on
 * the actual floorplan whenever heroIdx (computed independently, from the
 * feed's cover basename) happened to land on the same slot (29 Copeland
 * Crescent). isFloorplanBasename replaced that with the Domain basename
 * convention (`_3_` crop), independent of the image's position.
 *
 * tech-001/req-001 (round 1 of this run): the fix regressed by deciding
 * isFloorplan/isHero from `v.imgs[i]` -- the i-th URL of the RAW PASS
 * CAPTURE -- applied at `imgs[i]`, the i-th LIVE/stored image. Those two
 * arrays are not the same sequence (dedupSlots, the zero-photo gate, a
 * floorplan-only append all shift them out of alignment), so the `_3_` check
 * landed on the wrong image on 6 real listings. decideImages/heroIndexFor fix
 * this by deciding everything from each live image's OWN sourceUrl.
 *
 * tests-001 (Critical, round 1): the regression guard for root cause 5 did
 * not exercise production code -- it reimplemented the notes ternary inline.
 * This file now imports notesFor/decideImages/heroIndexFor from the script
 * itself instead.
 */
import assert from "node:assert";

interface Img {
  id: string;
  sourceUrl: string | null;
  tagged: boolean;
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
}

async function main() {
  const { isFloorplanBasename, notesFor, heroIndexFor, decideImages } = await import("../scripts/_tag-remote");

  const img = (id: string, sourceUrl: string, overrides: Partial<Img> = {}): Img => ({
    id,
    sourceUrl,
    tagged: false,
    roomType: null,
    notes: null,
    taggedBy: null,
    ...overrides,
  });

  // --- a `_3_` image is detected as a floorplan regardless of position ---
  const nonLastFloorplan = "https://rimh2/x/4030000001_2_3_260101_99.jpg";
  assert.equal(isFloorplanBasename(nonLastFloorplan), true, "a `_3_` basename is a floorplan");

  // --- REGRESSION GUARD: a LAST non-`_3_` image is NOT treated as a floorplan ---
  const lastPhoto = "https://rimh2/x/4030000001_3_1_260101_99.jpg";
  assert.equal(
    isFloorplanBasename(lastPhoto),
    false,
    "a last-position image whose basename is NOT `_3_` must not be classified as a floorplan",
  );

  // --- a `_3_` image is never eligible for notes='hero' ---
  assert.equal(
    notesFor(true, true, "m"),
    "floorplan",
    "REGRESSION GUARD: even when isHero is also true, notes must be 'floorplan', never 'hero' (29 Copeland Crescent)",
  );
  assert.equal(notesFor(false, true, "m"), "hero", "a non-floorplan hero still gets notes='hero'");
  assert.equal(notesFor(false, false, "m"), "local:m", "neither floorplan nor hero falls through to the model tag");

  // --- REGRESSION GUARD (tech-001/req-001): isFloorplan/isHero come from
  // each live image's OWN sourceUrl, never from a position shared with some
  // other (differently-shaped) array like the raw pass capture. Fixture: the
  // stored/live gallery holds the photo FIRST and the floorplan THIRD -- the
  // exact "more live images than the raw _3_ index+1" shift the brief
  // measured on 6 real listings (29 Copeland Crescent and others). ---
  {
    const cover = "2021200120_1_1_260101_99.jpg";
    const imgs: Img[] = [
      img("img_cover", "https://rimh2/x/2021200120_1_1_260101_99.jpg"), // the real cover
      img("img_other", "https://rimh2/x/2021200120_2_1_260101_99.jpg"), // an ordinary photo
      img("img_plan", "https://rimh2/x/2021200120_3_3_260101_99.jpg"), // the real floorplan
    ];
    const decisions = decideImages(imgs, cover);
    assert.equal(decisions[2].isFloorplan, true, "the `_3_` image is flagged floorplan from its OWN sourceUrl");
    assert.equal(decisions[0].isFloorplan, false, "the cover photo is not a floorplan");
    assert.equal(decisions[1].isFloorplan, false, "the middle photo is not a floorplan");
    assert.equal(decisions[0].isHero, true, "the cover is matched by its OWN sourceUrl's basename");
    assert.equal(decisions[2].isHero, false, "the floorplan slot is never also flagged hero");
  }

  // --- REGRESSION GUARD: hero and floorplan coinciding on the SAME image
  // (29 Copeland Crescent's exact shape) still comes out notes='floorplan'. ---
  {
    const cover = "500_1_3_260101_99.jpg";
    const imgs: Img[] = [img("img_fp", "https://rimh2/x/500_1_3_260101_99.jpg")];
    const decisions = decideImages(imgs, cover);
    assert.equal(decisions[0].isHero, true, "the only image's basename matches the cover");
    assert.equal(decisions[0].isFloorplan, true, "and it is also a `_3_` floorplan");
    assert.equal(
      notesFor(decisions[0].isFloorplan, decisions[0].isHero, "m"),
      "floorplan",
      "REGRESSION GUARD: floorplan outranks hero even when both are true for the same image",
    );
  }

  // --- heroIndexFor: exact basename match ---
  {
    const imgs: Img[] = [
      img("a", "https://rimh2/x/500_1_1_260101.jpg"),
      img("b", "https://rimh2/x/500_2_1_260101.jpg"),
    ];
    assert.equal(heroIndexFor(imgs, "500_2_1_260101.jpg"), 1, "exact basename match returns its index");
  }

  // --- heroIndexFor: <id>_<n>_ prefix fallback (relist keeps old photo ids) ---
  {
    const imgs: Img[] = [
      img("a", "https://rimh2/x/500_1_1_260101.jpg"),
      img("c", "https://rimh2/x/500_3_1_oldsuffix.jpg"),
    ];
    assert.equal(
      heroIndexFor(imgs, "500_3_1_newsuffix-w1600-h1067.jpg"),
      1,
      "prefix fallback finds the image sharing the <id>_<n>_ prefix",
    );
  }

  // --- heroIndexFor: no cover or no match -> -1 ---
  {
    const imgs: Img[] = [img("a", "https://rimh2/x/500_1_1_260101.jpg")];
    assert.equal(heroIndexFor(imgs, ""), -1, "no cover -> -1");
    assert.equal(heroIndexFor(imgs, "999_9_1_notstored.jpg"), -1, "no stored match -> -1");
  }

  console.log("✓ tag-remote-floorplan.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ tag-remote-floorplan.test FAILED:", e);
  process.exit(1);
});
