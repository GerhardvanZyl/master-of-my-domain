/**
 * Tests for scripts/_hero-sync-live.mjs's findHeroTarget/heroSyncTags/
 * coverForProperty -- root cause 4 of run
 * 20261003-1801-fix-domain-floorplans-heroes: heroes were only ever set for a
 * listing tagged in the SAME pass, so when an agent changed the cover on
 * Domain the old hero was never cleared and never revisited (29 of 303 live
 * Domain listings not matching the feed's current cover, 4 with two heroes,
 * measured 2026-10-03).
 *
 * req-002 (round 1 of this run): the feed match was by `listingUrl` only, so
 * a RELISTED property -- new Domain listing id, `externalId` follows, but
 * `listingUrl` stays the OLD one -- was never found in the feed and silently
 * reported `notInFeed`, even though a relist is exactly the shape most
 * likely to have a new cover. coverForProperty adds the `externalId`
 * fallback, same `extOf` idea _pass-apply-live.mjs already uses.
 *
 * req-004 (lead's remedy, round 1): the brief's skip rule named only a
 * CURRENT hero tagged 'user'; the hard constraint ("a user tag is never
 * overwritten by any new path") is wider and wins. A target image that is
 * itself hand-tagged (tagged_by='user') with a real notes value must also be
 * skipped, reported 'user-target' -- a user-tagged target with notes===null
 * carries no hand data to lose and may still take the hero mark.
 *
 * No network: all functions under test are pure, operating on in-memory
 * arrays shaped like getLiveImages()/getAllLiveProperties()'s return values.
 */
import assert from "node:assert";

interface Img {
  id: string;
  sourceUrl: string;
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
  confidence?: number | null;
}

interface TagRow {
  imageId: string;
  roomType: string | null;
  confidence: number | null;
  notes: string | null;
  taggedBy: string | null;
}

async function main() {
  const { findHeroTarget, heroSyncTags, buildCoverMaps, coverForProperty } = await import(
    "../scripts/_hero-sync-live.mjs"
  );

  // --- findHeroTarget: exact basename match ---
  {
    const imgs: Img[] = [
      {
        id: "img_a",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "local-vlm",
      },
      {
        id: "img_b",
        sourceUrl: "https://rimh2/x/500_2_1_260101.jpg",
        roomType: "living",
        notes: null,
        taggedBy: "local-vlm",
      },
    ];
    const target = findHeroTarget(imgs, "500_2_1_260101.jpg");
    assert.ok(target, "exact basename match finds a target");
    assert.equal(target.id, "img_b", "exact basename match returns the right image");
  }

  // --- findHeroTarget: <id>_<n>_ prefix fallback (relist keeps old photo ids, new cover reference) ---
  {
    const imgs: Img[] = [
      {
        id: "img_a",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "local-vlm",
      },
      {
        id: "img_c",
        sourceUrl: "https://rimh2/x/500_3_1_oldsuffix.jpg",
        roomType: "living",
        notes: null,
        taggedBy: "local-vlm",
      },
    ];
    // Cover's basename differs in everything after the `<id>_<n>_` prefix --
    // no exact match exists, so the prefix fallback must find img_c.
    const target = findHeroTarget(imgs, "500_3_1_newsuffix-w1600-h1067.jpg");
    assert.ok(target, "prefix fallback finds a target when no exact basename matches");
    assert.equal(target.id, "img_c", "prefix fallback returns the image sharing the <id>_<n>_ prefix");
  }

  // --- findHeroTarget: no target when nothing matches ---
  {
    const imgs: Img[] = [
      {
        id: "img_a",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "local-vlm",
      },
    ];
    assert.equal(findHeroTarget(imgs, "999_9_1_notstored.jpg"), null, "no stored image matches -> null target");
  }

  // --- heroSyncTags: no target -> skip "no-target" ---
  {
    const imgs: Img[] = [
      {
        id: "img_a",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "local-vlm",
      },
    ];
    const result = heroSyncTags(imgs, null);
    assert.equal(result.skip, "no-target", "a null target (cover not stored) is reported as skip: no-target");
  }

  // --- heroSyncTags: any current hero with taggedBy='user' -> skip "user-hero" ---
  {
    const imgs: Img[] = [
      {
        id: "img_a",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: "hero",
        taggedBy: "user",
      },
      {
        id: "img_b",
        sourceUrl: "https://rimh2/x/500_2_1_260101.jpg",
        roomType: "living",
        notes: null,
        taggedBy: "local-vlm",
      },
    ];
    const target = imgs[1]; // a real target exists, but must still be skipped
    const result = heroSyncTags(imgs, target);
    const msg = "REGRESSION GUARD: a hand-picked hero must never be repointed, even when a valid new target is found";
    assert.equal(result.skip, "user-hero", msg);
  }

  // --- heroSyncTags: already correct -> emits nothing (idempotent) ---
  {
    const imgs: Img[] = [
      {
        id: "img_a",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: "hero",
        taggedBy: "domain-cover",
      },
      {
        id: "img_b",
        sourceUrl: "https://rimh2/x/500_2_1_260101.jpg",
        roomType: "living",
        notes: null,
        taggedBy: "local-vlm",
      },
    ];
    const target = imgs[0];
    const result = heroSyncTags(imgs, target);
    assert.ok(!result.skip, "no skip reason when the hero is already correct");
    const idemMsg =
      "REGRESSION GUARD: already-correct hero state emits an EMPTY tags array -- this is " +
      "what makes a re-run idempotent";
    assert.deepEqual(result.tags, [], idemMsg);
  }

  // --- heroSyncTags: stray extra heroes are cleared (notes -> null) ---
  {
    const imgs: Img[] = [
      {
        id: "img_target",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "local-vlm",
      },
      {
        id: "img_strayA",
        sourceUrl: "https://rimh2/x/500_2_1_260101.jpg",
        roomType: "living",
        notes: "hero",
        taggedBy: "local-vlm",
      },
      {
        id: "img_strayB",
        sourceUrl: "https://rimh2/x/500_3_1_260101.jpg",
        roomType: "bathroom",
        notes: "hero",
        taggedBy: "local-vlm",
      },
    ];
    const target = imgs[0];
    const result = heroSyncTags(imgs, target);
    assert.ok(!result.skip, "no skip when converging to a real target");
    const byId = new Map(result.tags!.map((t: TagRow) => [t.imageId, t] as [string, TagRow]));
    assert.ok(byId.has("img_target"), "the target itself gets a tag row promoting it to hero");
    assert.equal(byId.get("img_target")!.notes, "hero", "target promoted to hero");
    assert.ok(byId.has("img_strayA"), "stray hero A is cleared");
    const strayMsg = "REGRESSION GUARD: a stray extra hero (non-floorplan basename) has notes cleared to null";
    assert.equal(byId.get("img_strayA")!.notes, null, strayMsg);
    assert.ok(byId.has("img_strayB"), "stray hero B is cleared");
    assert.equal(byId.get("img_strayB")!.notes, null, "stray hero B also cleared");
  }

  // --- heroSyncTags: a stray `_3_` hero becomes notes='floorplan', not null ---
  {
    const imgs: Img[] = [
      {
        id: "img_target",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "local-vlm",
      },
      {
        id: "img_strayFp",
        sourceUrl: "https://rimh2/x/500_2_3_260101.jpg",
        roomType: "other",
        notes: "hero",
        taggedBy: "local-vlm",
      },
    ];
    const target = imgs[0];
    const result = heroSyncTags(imgs, target);
    const byId = new Map(result.tags!.map((t: TagRow) => [t.imageId, t] as [string, TagRow]));
    const fpMsg =
      "REGRESSION GUARD: a stray hero whose own basename is `_3_` (a genuine floorplan) is " +
      "demoted to notes='floorplan', not left null";
    assert.equal(byId.get("img_strayFp")!.notes, "floorplan", fpMsg);
  }

  // --- heroSyncTags: target keeps its existing room_type / tagged_by ---
  {
    const imgs: Img[] = [
      {
        id: "img_target",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "claude-code",
      },
    ];
    const target = imgs[0];
    const result = heroSyncTags(imgs, target);
    const row = result.tags!.find((t: TagRow) => t.imageId === "img_target")!;
    assert.equal(row.roomType, "kitchen", "target's existing room_type is preserved, not reset");
    const taggedByMsg = "target's existing taggedBy is preserved, not overwritten with 'domain-cover'";
    assert.equal(row.taggedBy, "claude-code", taggedByMsg);
  }

  // --- REGRESSION GUARD (req-004): a target that is itself hand-tagged
  // (tagged_by='user') with a REAL notes value (e.g. a hand-marked
  // 'floorplan') must be skipped, never promoted to hero -- the hard
  // constraint against overwriting a user tag outranks the brief's narrower
  // "current hero only" skip rule. ---
  {
    const imgs: Img[] = [
      {
        id: "img_target",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: "floorplan",
        taggedBy: "user",
      },
    ];
    const target = imgs[0];
    const result = heroSyncTags(imgs, target);
    const userTargetMsg =
      "REGRESSION GUARD: a hand-tagged target with a real notes value is skipped (user-target), never promoted to hero";
    assert.equal(result.skip, "user-target", userTargetMsg);
  }

  // --- a user-tagged target with notes===null carries no hand data to lose
  // and MAY still take the hero mark. ---
  {
    const imgs: Img[] = [
      {
        id: "img_target",
        sourceUrl: "https://rimh2/x/500_1_1_260101.jpg",
        roomType: "kitchen",
        notes: null,
        taggedBy: "user",
      },
    ];
    const target = imgs[0];
    const result = heroSyncTags(imgs, target);
    assert.ok(!result.skip, "a user-tagged target with null notes is not skipped");
    const row = result.tags!.find((t: TagRow) => t.imageId === "img_target")!;
    assert.equal(row.notes, "hero", "the null-notes user target is promoted to hero");
  }

  // --- REGRESSION GUARD (req-002): coverForProperty falls back to the
  // feed's trailing listing id against the live property's externalId when
  // listingUrl misses -- the RELIST shape: the server merges the relist onto
  // the existing row by address, so the held row's listingUrl still ends in
  // the OLD id while externalId already follows the NEW one, and the feed
  // (seen only under the new id) never matches by URL. ---
  {
    const feedRows = [
      // column 0: path (old.com.au prefix added by buildCoverMaps), column 15: cover basename.
      [
        "/9-relisted-st-point-cook-vic-3030-2021999999",
        ...Array(14).fill(""),
        "2021999999_1_1_260101_99-w1600-h1067.jpg",
      ],
    ];
    const { coverByUrl, coverByExt } = buildCoverMaps(feedRows);

    const relistedProperty = {
      listingUrl: "https://www.domain.com.au/9-relisted-st-point-cook-vic-3030-2021000000", // OLD id
      externalId: "2021999999", // NEW id -- matches the feed row
    };
    const cover = coverForProperty(relistedProperty, coverByUrl, coverByExt);
    const relistMsg =
      "REGRESSION GUARD: listingUrl misses (old id), but externalId matches the feed's trailing listing id (new id)";
    assert.equal(cover, "2021999999_1_1_260101_99-w1600-h1067.jpg", relistMsg);

    // A listing truly absent from the feed (no URL match, no externalId
    // match) must still report "" -- the caller treats that as notInFeed.
    const absentProperty = { listingUrl: "https://www.domain.com.au/not-in-feed-1", externalId: "7777777777" };
    const absentCover = coverForProperty(absentProperty, coverByUrl, coverByExt);
    assert.equal(absentCover, "", "a genuinely absent listing stays unmatched");

    // The straightforward (non-relist) case: exact listingUrl match wins,
    // with no need to even look at externalId.
    const normalProperty = {
      listingUrl: "https://www.domain.com.au/9-relisted-st-point-cook-vic-3030-2021999999",
      externalId: null,
    };
    assert.equal(
      coverForProperty(normalProperty, coverByUrl, coverByExt),
      "2021999999_1_1_260101_99-w1600-h1067.jpg",
      "an exact listingUrl match is used directly, no externalId needed",
    );
  }

  console.log("✓ hero-sync-live.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ hero-sync-live.test FAILED:", e);
  process.exit(1);
});
