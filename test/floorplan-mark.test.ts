/**
 * Tests for markFloorplanImages (src/db/queries/tags.ts) and the
 * `floorplanUrls` field of POST /api/batch's `images[]` entries — root causes
 * 3 and 5 of run 20261003-1801-fix-domain-floorplans-heroes: a square
 * floorplan stored invisibly can only ever be tagged by the server at insert
 * time, because the only HTTP read path (the rendered page) never lists it.
 *
 * No network: every `imageUrls` sent through the route is `[]`, so syncImages
 * has nothing to download. Images are pre-seeded directly into the temp DB to
 * simulate rows a prior sync already stored. Temp DB, set BEFORE importing
 * app modules (same pattern as test/batch.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-floorplan-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

type Json = Record<string, unknown>;
const sec = <T>(j: Json, k: string): T => j[k] as T;

async function post(body: unknown): Promise<{ status: number; json: Json }> {
  const { POST } = await import("../src/app/api/batch/route");
  const res = await POST(
    new Request("http://localhost:3225/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Json };
}

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { markFloorplanImages } = await import("../src/db/queries/tags");
  migrate();

  let n = 0;
  const nextUrl = () => {
    n++;
    return `https://www.domain.com.au/${n}-fp-st-point-cook-vic-3030-20300000${n}`;
  };

  async function createProperty(): Promise<{ id: string; listingUrl: string }> {
    const listingUrl = nextUrl();
    await post({
      properties: [{ listingUrl, sourceSite: "domain", address: `${n} Fp St`, suburb: "Point Cook" }],
    });
    const id = (sqlite.prepare("SELECT id FROM properties WHERE listing_url = ?").get(listingUrl) as { id: string })
      .id;
    return { id, listingUrl };
  }

  let imgN = 0;
  function insertImage(propertyId: string, sourceUrl: string): string {
    imgN++;
    const id = `img_fp_${imgN}`;
    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO images (id, property_id, source_url, local_path, ordinal, created_at) VALUES (?,?,?,?,?,?)")
      .run(id, propertyId, sourceUrl, `images/x/${id}.jpg`, imgN, now);
    return id;
  }

  function insertTag(imageId: string, roomType: string | null, taggedBy: string, notes: string | null) {
    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO image_tags (image_id, room_type, tagged_by, tagged_at, notes) VALUES (?,?,?,?,?)")
      .run(imageId, roomType, taggedBy, now, notes);
  }

  type TagRow = { roomType: string | null; taggedBy: string | null; notes: string | null; taggedAt: string | null };

  function getTag(imageId: string): TagRow {
    return sqlite
      .prepare(
        "SELECT room_type roomType, tagged_by taggedBy, notes, tagged_at taggedAt FROM image_tags WHERE image_id = ?",
      )
      .get(imageId) as TagRow;
  }

  // --- 1. exact URL match, untagged image -> notes='floorplan', room_type='other' ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const fpUrl = "https://rimh2/x/2030000001_1_3_260101_99-w1200-h1200.jpg";
    const imgId = insertImage(propId, fpUrl);

    const res = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [fpUrl] }] });
    assert.equal(res.status, 200, "exact-url case: route does not 500");
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      1,
      "response.images.floorplansMarked counts the exact-url match",
    );
    assert.equal(
      sec<{ perListing: { floorplansMarked: number }[] }>(res.json, "images").perListing[0].floorplansMarked,
      1,
      "perListing entry also carries floorplansMarked",
    );
    const tag = getTag(imgId);
    assert.equal(tag.notes, "floorplan", "exact URL match marks notes='floorplan'");
    assert.equal(tag.roomType, "other", "untagged image gets room_type='other'");
  }

  // --- 2. basename match after Domain re-signs the URL (older row kept by dedup) ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const basename = "2030000002_2_3_260101_99-w1200-h1200.jpg";
    const oldSignedUrl = `https://rimh2/old-signed/${basename}`;
    const newSignedUrl = `https://rimh2/new-signed-xyz/${basename}?sig=abc123`;
    const imgId = insertImage(propId, oldSignedUrl);

    const res = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [newSignedUrl] }] });
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      1,
      "a re-signed URL still matches the stored (older) row by basename",
    );
    assert.equal(getTag(imgId).notes, "floorplan", "basename match marks the OLD stored row's notes");
  }

  // --- 3. keeps an existing room_type rather than overwriting it to 'other' ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const fpUrl = "https://rimh2/x/2030000003_1_3_260101_99-w1200-h1200.jpg";
    const imgId = insertImage(propId, fpUrl);
    insertTag(imgId, "living", "local-vlm", null);

    await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [fpUrl] }] });
    const tag = getTag(imgId);
    assert.equal(tag.notes, "floorplan", "notes set to floorplan");
    assert.equal(tag.roomType, "living", "existing room_type is kept, not reset to 'other'");
  }

  // --- 4. never overwrites a hand correction (tagged_by='user') ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const fpUrl = "https://rimh2/x/2030000004_1_3_260101_99-w1200-h1200.jpg";
    const imgId = insertImage(propId, fpUrl);
    insertTag(imgId, "kitchen", "user", null);

    const res = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [fpUrl] }] });
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      0,
      "a user-tagged row is not counted as marked",
    );
    const tag = getTag(imgId);
    assert.equal(tag.notes, null, "user hand-correction's notes is untouched");
    assert.equal(tag.roomType, "kitchen", "user hand-correction's room_type is untouched");
    assert.equal(tag.taggedBy, "user", "tagged_by stays 'user'");
  }

  // --- 5. never overwrites an existing hero ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const fpUrl = "https://rimh2/x/2030000005_1_3_260101_99-w1200-h1200.jpg";
    const imgId = insertImage(propId, fpUrl);
    insertTag(imgId, "kitchen", "domain-cover", "hero");

    const res = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [fpUrl] }] });
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      0,
      "an existing hero is not counted as marked",
    );
    const tag = getTag(imgId);
    assert.equal(tag.notes, "hero", "the hero marker survives the floorplan mark attempt");
  }

  // --- 6. idempotent: a second call leaves the row unchanged, including
  // tagged_at, AND reports floorplansMarked: 0 -- `marked` counts only rows
  // this call actually wrote, not rows it merely matched (req-005). ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const fpUrl = "https://rimh2/x/2030000006_1_3_260101_99-w1200-h1200.jpg";
    const imgId = insertImage(propId, fpUrl);

    const res1 = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [fpUrl] }] });
    const after1 = getTag(imgId);
    assert.equal(after1.notes, "floorplan", "sanity: first call marked it");
    assert.equal(
      sec<{ floorplansMarked: number }>(res1.json, "images").floorplansMarked,
      1,
      "sanity: first call reports 1 newly marked",
    );

    // Second call, same payload: the row is already correctly marked, so this
    // is the no-op path -- it must not be counted as marked again.
    const res2 = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [fpUrl] }] });
    const after2 = getTag(imgId);
    assert.deepEqual(after2, after1, "re-running the same floorplanUrls is a complete no-op, including tagged_at");
    assert.equal(
      sec<{ floorplansMarked: number }>(res2.json, "images").floorplansMarked,
      0,
      "a second identical call reports floorplansMarked: 0, not the matched count",
    );

    // Direct call confirms the same on markFloorplanImages itself, not just
    // through the route's aggregation.
    const direct = markFloorplanImages(propId, [fpUrl]);
    assert.equal(direct.marked, 0, "markFloorplanImages direct call: already-marked row returns marked: 0");
  }

  // --- 7. an entry WITHOUT floorplanUrls behaves exactly as before: no tag rows created ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const imgId = insertImage(propId, "https://rimh2/x/2030000007_1_1_260101_99-w1600-h1067.jpg");

    const res = await post({ images: [{ listingUrl, imageUrls: [] }] });
    assert.equal(res.status, 200, "an images entry with no floorplanUrls key does not 500");
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      0,
      "no floorplansMarked when floorplanUrls is absent",
    );
    assert.equal(
      sec<{ perListing: { floorplansMarked: number }[] }>(res.json, "images").perListing[0].floorplansMarked,
      0,
      "perListing also reports 0",
    );
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) c FROM image_tags WHERE image_id = ?").get(imgId) as { c: number }).c,
      0,
      "no image_tags row was created for the untouched image",
    );
  }

  // --- 8. markFloorplanImages direct call: no floorplanUrls at all is a pure no-op ---
  {
    const { id: propId } = await createProperty();
    const result = markFloorplanImages(propId, []);
    assert.equal(result.marked, 0, "an empty floorplanUrls array marks nothing");
  }

  // --- 9. REGRESSION GUARD (tech-002): an REA-style floorplan basename
  // ("image.jpg") must NEVER fall back to basename matching -- every REA
  // photo and floorplan shares that exact basename, so the fallback would
  // mark every stored image of the property, not just the floorplan. The
  // basename fallback is Domain-slot-shaped-only (/^\d+_\d+_\d+_/); an
  // REA-style basename is matched by EXACT source_url only. ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const floorplanUrl = "https://rea-cdn/x/floorplan/image.jpg?w=800";
    const otherPhotoUrl = "https://rea-cdn/x/photo-kitchen/image.jpg?w=800";
    const fpImgId = insertImage(propId, floorplanUrl);
    const otherImgId = insertImage(propId, otherPhotoUrl);
    insertTag(otherImgId, "kitchen", "local-vlm", null);

    const res = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [floorplanUrl] }] });
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      1,
      "REGRESSION GUARD: only the exact-URL match is marked, not every image sharing the REA 'image.jpg' basename",
    );
    assert.equal(getTag(fpImgId).notes, "floorplan", "the exact-URL floorplan is marked");
    const otherTag = getTag(otherImgId);
    assert.equal(
      otherTag.notes,
      null,
      "REGRESSION GUARD: a different REA photo sharing the same 'image.jpg' basename is NOT marked floorplan",
    );
    assert.equal(otherTag.roomType, "kitchen", "the other photo's existing room_type survives untouched");
  }

  // --- 10. a Domain-slot-shaped basename still falls back correctly (unchanged) ---
  {
    const { id: propId, listingUrl } = await createProperty();
    const basename = "2030000010_1_3_260101_99-w1200-h1200.jpg";
    const oldSignedUrl = `https://rimh2/old-signed/${basename}`;
    const newSignedUrl = `https://rimh2/new-signed-xyz/${basename}?sig=abc123`;
    const imgId = insertImage(propId, oldSignedUrl);

    const res = await post({ images: [{ listingUrl, imageUrls: [], floorplanUrls: [newSignedUrl] }] });
    assert.equal(
      sec<{ floorplansMarked: number }>(res.json, "images").floorplansMarked,
      1,
      "a Domain slot-shaped basename still matches the stored (older) row after Domain re-signs the URL",
    );
    assert.equal(getTag(imgId).notes, "floorplan", "Domain basename fallback still marks the right row");
  }

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ floorplan-mark.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ floorplan-mark.test FAILED:", e);
  process.exit(1);
});
