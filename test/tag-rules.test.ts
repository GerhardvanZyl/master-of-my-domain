/**
 * scripts/_tag-remote.ts's pure decision predicates — ifAbsentFor,
 * shouldClassify, roomTypeFor — folded in here as they're implemented,
 * without the network harness the rest of scripts/ deliberately doesn't have.
 *
 * Was test/tag-rules.test.ts against scripts/_tag-rules.ts, a sibling module
 * that existed only to make ifAbsentFor importable around the script's
 * unconditional main(); retired in round 2 of
 * 20260823-1800-fix-tagging-round-defects (arch-004) once _tag-remote.ts
 * gained an isMain entrypoint guard, so the predicates are exported directly
 * from the script they belong to.
 *
 * shouldClassify is the tech-004 (round 2) regression: fixing
 * detectTaggedImages (tech-001, round 1) made the "already tagged, don't
 * reclassify" skip fire for the first time, and without the isLast exemption
 * it silently made notes:"floorplan" unreachable for exactly the images it
 * exists for (every already-tagged last-position photo). Confirmed fail-first
 * by mutation: reverting shouldClassify to `isHero || !tagged` (the pre-fix
 * behaviour, i.e. line 130's original `if (im.tagged && !isHero) continue`)
 * makes the second assertion below fail.
 *
 * ifAbsentFor gained a fourth input, `existingNotes`, in round 3 (tech-006):
 * it decided the floorplan overwrite from WHO wrote the existing tag and
 * never from WHAT it says, so a last visible image already carrying
 * notes='hero' had that marker silently destroyed. shouldClassify was then
 * updated (tech-007, round 3) to ask ifAbsentFor directly whether the
 * floorplan mark could land at all, rather than re-deriving the same
 * machine/hand partition — so the two predicates cannot drift apart again.
 */
import assert from "node:assert";
import { ifAbsentFor, roomTypeFor, shouldClassify } from "../scripts/_tag-remote";

// --- shouldClassify -- tech-004 / tech-006 / tech-007 ---

// The hero and an untagged image were always exempt from the skip,
// regardless of the existing tag row.
assert.equal(
  shouldClassify(false, false, false, null, null),
  true,
  "an untagged image is always classified",
);
assert.equal(
  shouldClassify(true, true, false, "local-vlm", "hero"),
  true,
  "the hero is always classified, tagged or not, even if already correctly hero-tagged",
);

// The tech-004 regression: an already-tagged image that is NOT the hero but
// IS the last (the only slot a floorplan mark can ever apply to) must still
// be classified when the mark could actually land -- otherwise it can never
// be re-examined for notes:"floorplan".
assert.equal(
  shouldClassify(true, false, true, "local-vlm", null),
  true,
  "an already-tagged LAST image is classified when the floorplan mark could still land (machine-owned)",
);

// Everything else already-tagged, non-hero, non-last is correctly skipped --
// this is the guard tech-001 made real and must not regress back to fail-open.
assert.equal(
  shouldClassify(true, false, false, null, null),
  false,
  "an already-tagged, non-hero, non-last image is skipped (no wasted reclassification)",
);

// The tech-007 regression: an already-tagged, non-hero LAST image whose
// existing tag is hand-owned cannot be changed by any verdict the model
// returns (ifAbsentFor protects it), so the model call is skipped -- it is
// no longer exempted just because it's last.
assert.equal(
  shouldClassify(true, false, true, "claude-code", null),
  false,
  "an already-tagged LAST image is skipped when hand-owned -- the floorplan mark could not land regardless of verdict",
);

// Same skip, via the tech-006 path: a last image already marked notes='hero'
// cannot be overwritten by a floorplan mark even though its tagged_by is
// machine-owned -- the model call is equally wasted here.
assert.equal(
  shouldClassify(true, false, true, "local-vlm", "hero"),
  false,
  "an already-tagged LAST image already marked hero is skipped -- the floorplan mark could not land",
);

// --- ifAbsentFor -- tech-001 (guard) / tech-004 (floorplan gate) / tech-006 (hero protection) ---

// Hero always overwrites (notes="hero" is the model verdict's notes for the
// hero slot regardless of what was there before).
assert.equal(ifAbsentFor(true, "hero", null, null), false, "hero row overwrites unconditionally");

// Floorplan on an image with no existing tag row -- nothing to protect.
assert.equal(ifAbsentFor(false, "floorplan", null, null), false, "floorplan row overwrites an absent tag");

// Floorplan on an image already carrying a MACHINE-written tag -- safe to
// overwrite (that's the entire point of Change 1: a last-position photo the
// generic model already called "other", "living", etc. still needs its
// floorplan mark).
assert.equal(
  ifAbsentFor(false, "floorplan", "local-vlm", null),
  false,
  "floorplan row overwrites a machine (local-vlm) tag",
);
assert.equal(
  ifAbsentFor(false, "floorplan", "migration", null),
  false,
  "floorplan row overwrites a migration-sweep tag",
);
assert.equal(
  ifAbsentFor(false, "floorplan", "rule", null),
  false,
  "floorplan row overwrites a deterministic rule-based tag (e.g. SVG -> exclude)",
);

// Floorplan on an image already carrying a HAND-curated tag -- must not be
// silently clobbered (this is exactly the hazard tech-001 raised).
assert.equal(
  ifAbsentFor(false, "floorplan", "claude-code", null),
  true,
  "floorplan row never overwrites a hand-corrected (claude-code) tag",
);
assert.equal(
  ifAbsentFor(false, "floorplan", "domain-cover", null),
  true,
  "floorplan row never overwrites a domain-cover tag",
);
assert.equal(ifAbsentFor(false, "floorplan", "user", null), true, "floorplan row never overwrites a user-set tag");

// tech-006: floorplan on an image whose EXISTING notes is 'hero' must never
// be overwritten, even when tagged_by is machine-owned -- notes is the only
// column the floorplan mark writes, so overwriting it would silently destroy
// the hero marker regardless of who wrote it.
assert.equal(
  ifAbsentFor(false, "floorplan", "local-vlm", "hero"),
  true,
  "floorplan row never overwrites an existing hero marker, even when tagged_by is machine-owned",
);
assert.equal(
  ifAbsentFor(false, "floorplan", null, "hero"),
  true,
  "floorplan row never overwrites an existing hero marker, even with no tagged_by at all",
);

// A plain room classification never clobbers whatever tag row is already
// there -- including one a human corrected in the UI.
assert.equal(
  ifAbsentFor(false, "local:qwen/qwen3-vl-8b", "claude-code", null),
  true,
  "plain room tag never overwrites",
);
assert.equal(ifAbsentFor(false, null, null, null), true, "no notes value never overwrites");

// --- roomTypeFor -- tech-004 (preserve existing classification) ---

// Floorplan on an already-classified image keeps the EXISTING roomType --
// floorplan is a notes value, not a room type, and the generic model prompt
// collapses floorplans into "other" regardless of what's actually pictured
// (same precedent as scripts/_recover-floorplans.ts).
assert.equal(
  roomTypeFor("floorplan", "other", "living"),
  "living",
  "floorplan preserves an already-classified image's existing roomType",
);

// Floorplan on an image with no existing roomType falls back to the fresh verdict.
assert.equal(
  roomTypeFor("floorplan", "other", null),
  "other",
  "floorplan with no existing roomType uses the fresh verdict",
);

// Any non-floorplan notes always uses the fresh verdict.
assert.equal(
  roomTypeFor("hero", "kitchen", "living"),
  "kitchen",
  "hero (and every other non-floorplan case) always uses the fresh verdict",
);

console.log("✓ tag-rules.test: all assertions passed");
