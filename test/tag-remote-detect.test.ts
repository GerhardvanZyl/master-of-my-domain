/**
 * Regression test for tech-001 (round 1 of 20260823-1800-fix-tagging-round-
 * defects): scripts/_tag-remote.ts's tagged-image detector reported every
 * image as untagged -- measured live as 114 of 114 false negatives across 5
 * properties -- because its badge regex matched the FIRST occurrence of an
 * image id in the document, which is always inside a next/image imagesrcset
 * preload with no badge text nearby; the real badge appears later in the
 * page and the dedup-by-first-occurrence logic never reaches it.
 *
 * Fixture below is CONSTRUCTED, not captured from a live page, but
 * faithfully reproduces that preload-then-badge ordering, plus a
 * self.__next_f flight chunk carrying the real DB roomType/notes/taggedBy
 * columns for the same image id -- the same shape _live-http.mjs's
 * getLiveImages() reads in production.
 */
import assert from "node:assert";

/** Build a `self.__next_f.push([1,"..."])` chunk whose escaped payload,
 * once unescaped by _live-http.mjs's fetchFlightFlat, equals `rawJson`. */
function flightScript(rawJson: string): string {
  const inner = JSON.stringify(rawJson).slice(1, -1);
  return `<script>self.__next_f.push([1,"${inner}"])</script>`;
}

// The real badge markup must sit further than 400 chars past the FIRST
// "img_abc123.webp" occurrence (the imagesrcset preload) -- that gap, and the
// dedup-by-first-occurrence logic, is exactly what made the badge regex miss
// every real tag on the live app. FILLER reproduces that distance; without
// it the badge would fall inside the 400-char window and the (buggy) regex
// would find it, defeating the point of this fixture.
const FILLER = "x".repeat(500);

const FIXTURE_HTML = `
<link rel="preload" as="image" imagesrcset="/api/img/pid1/img_abc123.webp 1x, /api/img/pid1/img_abc123.webp 2x">
<!-- ${FILLER} -->
<main>
  <img src="/api/img/pid1/img_abc123.webp" />
  <span class="badge uppercase text-xs">kitchen</span>
</main>
${flightScript(
  '1:{"images":[{"id":"img_abc123","roomType":"kitchen","notes":null,"taggedBy":"claude-code","confidence":0.9}]}',
)}
`;

const realFetch = globalThis.fetch;
// @ts-expect-error -- narrower stub than the real fetch signature, sufficient for get()/fetchFlightFlat()
globalThis.fetch = async () => ({ ok: true, text: async () => FIXTURE_HTML });

async function main() {
  try {
    const { detectTaggedImages } = await import("../scripts/_tag-remote");
    const imgs = await detectTaggedImages("http://fixture.local", "pid1");
    const img = imgs.find((i) => i.id === "img_abc123");
    assert.ok(img, "the fixture image was found at all");
    assert.equal(
      img!.tagged,
      true,
      "img_abc123 carries a real roomType and must be detected as already tagged",
    );
    // tests-005: the carry-through of roomType/notes/taggedBy is the entire
    // mechanism ifAbsentFor/roomTypeFor rely on to tell a machine tag from a
    // hand correction -- assert on the actual values, not just `tagged`, so a
    // dropped or swapped field (e.g. notes/taggedBy swapped in the map body)
    // is caught. Both fields are `string | null`, so a type-checker cannot
    // catch that swap; only reading the values back can.
    assert.equal(img!.roomType, "kitchen", "roomType must be carried through from the DB row, unmodified");
    assert.equal(img!.notes, null, "notes must be carried through from the DB row, unmodified");
    assert.equal(img!.taggedBy, "claude-code", "taggedBy must be carried through from the DB row, unmodified");
    const { shouldClassifyRea } = await import("../scripts/_tag-remote-rea");

    // --- REA pass: what it will and will not overwrite ---
    // The only judgement in _tag-remote-rea.ts. Getting it wrong either
    // re-classifies 900 already-tagged photos for nothing, or silently
    // overwrites a correction someone made by hand.
    assert.equal(
      shouldClassifyRea({ roomType: null, taggedBy: null }),
      true,
      "an untagged REA image is classified",
    );
    assert.equal(
      shouldClassifyRea({ roomType: "kitchen", taggedBy: "local-vlm" }),
      true,
      "a model tag may be re-classified",
    );
    assert.equal(
      shouldClassifyRea({ roomType: "kitchen", taggedBy: "rule" }),
      true,
      "a deterministic rule tag may be re-classified",
    );
    assert.equal(
      shouldClassifyRea({ roomType: "kitchen", taggedBy: "claude-code" }),
      false,
      "a hand correction is left alone",
    );
    assert.equal(
      shouldClassifyRea({ roomType: "kitchen", taggedBy: "user" }),
      false,
      "the user's own tag is left alone",
    );

    console.log("✓ tag-remote-detect.test: all assertions passed");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((e) => {
  console.error("✗ tag-remote-detect.test FAILED:", e);
  process.exit(1);
});
