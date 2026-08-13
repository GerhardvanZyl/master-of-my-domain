/**
 * Offline test of POST /api/batch — the HTTP write path used to update the app
 * running on another host. No network: the images section is exercised via an
 * unknown listing_url, so syncImages is never reached.
 *
 * What matters here is that the endpoint and the CLIs agree on what they write,
 * and that one bad row in a batch does not discard the good ones. Temp DB, set
 * BEFORE importing app modules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-batch-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

const URL_A = "https://www.domain.com.au/1-alpha-st-point-cook-vic-3030-2020000001";
const URL_B = "https://www.domain.com.au/2-beta-st-point-cook-vic-3030-2020000002";

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
  migrate();
  const count = (sql: string, ...a: unknown[]) =>
    (sqlite.prepare(sql).get(...a) as { c: number }).c;

  // --- properties: same upsert semantics as `npm run load` ---
  const r1 = await post({
    properties: [
      { listingUrl: URL_A, sourceSite: "domain", externalId: "2020000001", address: "1 Alpha St", suburb: "Point Cook", beds: 4, priceDisplay: "$800,000", priceNumeric: 800000 },
      { listingUrl: URL_B, sourceSite: "domain", externalId: "2020000002", address: "2 Beta St", suburb: "Point Cook", beds: 3, priceDisplay: "$750,000", priceNumeric: 750000 },
    ],
  });
  assert.equal(r1.status, 200, "batch returns 200");
  assert.equal(r1.json.ok, true, "clean batch reports ok");
  assert.equal(sec<{ inserted: number }>(r1.json, "properties").inserted, 2, "2 inserted");

  // Re-sending is idempotent and partial — beds updates, address survives.
  const r2 = await post({ properties: [{ listingUrl: URL_A, beds: 5 }] });
  assert.equal(sec<{ updated: number }>(r2.json, "properties").updated, 1, "re-send updates");
  const propA = sqlite
    .prepare("SELECT id, beds, address FROM properties WHERE listing_url = ?")
    .get(URL_A) as { id: string; beds: number; address: string };
  assert.equal(propA.beds, 5, "partial load updated beds");
  assert.equal(propA.address, "1 Alpha St", "partial load did not null the address");
  assert.equal(count("SELECT COUNT(*) c FROM properties"), 2, "no duplicate rows");

  // --- tags: notes is what carries hero / floorplan / master ---
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO images (id, property_id, source_url, local_path, ordinal, created_at) VALUES (?,?,?,?,?,?)",
    )
    .run("img_test_1", propA.id, "https://rimh2/x/2020000001_1_0.jpg", "images/x/1.jpg", 0, now);

  const r3 = await post({
    tags: [
      { imageId: "img_test_1", roomType: "kitchen", notes: "hero", taggedBy: "domain-cover" },
      { imageId: "img_does_not_exist", roomType: "kitchen" },
      { imageId: "img_test_1", roomType: "not-a-room" },
    ],
  });
  assert.equal(r3.status, 200, "bad rows do not 4xx the whole batch");
  assert.equal(sec<{ written: number }>(r3.json, "tags").written, 1, "the good tag still landed");
  assert.equal(sec<unknown[]>(r3.json, "errors").length, 2, "both bad rows reported");
  assert.equal(r3.json.ok, false, "ok=false when any row failed");
  const tag = sqlite
    .prepare("SELECT room_type, notes FROM image_tags WHERE image_id = ?")
    .get("img_test_1") as { room_type: string; notes: string };
  assert.equal(tag.room_type, "kitchen", "room type stored");
  assert.equal(tag.notes, "hero", "notes stored — this is how the hero is marked");

  // ifAbsent must never clobber a tag a human corrected in the UI.
  const r4 = await post({ tags: [{ imageId: "img_test_1", roomType: "bathroom", ifAbsent: true }] });
  assert.equal(sec<{ skipped: number }>(r4.json, "tags").skipped, 1, "existing tag skipped");
  assert.equal(
    (sqlite.prepare("SELECT room_type r FROM image_tags WHERE image_id = ?").get("img_test_1") as { r: string }).r,
    "kitchen",
    "ifAbsent did not overwrite",
  );

  // --- groups: reused by label, membership deduped ---
  const r5 = await post({ groups: [{ label: "kitchen", roomType: "kitchen", imageIds: ["img_test_1"] }] });
  const g = sec<{ groupId: string; added: number }[]>(r5.json, "groups")[0];
  assert.equal(g.added, 1, "image added to group");
  const r6 = await post({ groups: [{ label: "KITCHEN", imageIds: ["img_test_1"] }] });
  assert.equal(sec<{ groupId: string }[]>(r6.json, "groups")[0].groupId, g.groupId, "group reused case-insensitively");
  assert.equal(count("SELECT COUNT(*) c FROM similarity_group_members"), 1, "duplicate membership ignored");

  // --- images: an unknown listing_url is an error row, not a thrown request ---
  const r7 = await post({ images: [{ listingUrl: "https://www.domain.com.au/nope-1", imageUrls: [] }] });
  assert.equal(r7.status, 200, "unknown listing url does not 500");
  assert.equal(sec<{ section: string }[]>(r7.json, "errors")[0].section, "images", "reported under images");

  // --- sold / withdrawn: must match what `npm run mark-sold` writes ---
  const r8 = await post({
    sold: [{ listingUrl: URL_A, price: 812000, date: "2026-08-11" }],
    withdrawn: [{ listingUrl: URL_B }],
  });
  assert.equal(sec<{ marked: number }>(r8.json, "sold").marked, 1, "1 sold");
  assert.equal(sec<{ marked: number }>(r8.json, "withdrawn").marked, 1, "1 withdrawn");
  assert.equal(
    (sqlite.prepare("SELECT status s FROM scrape_jobs WHERE url = ?").get(URL_A) as { s: string }).s,
    "sold",
    "sold status recorded",
  );
  assert.equal(
    (sqlite.prepare("SELECT status s FROM scrape_jobs WHERE url = ?").get(URL_B) as { s: string }).s,
    "withdrawn",
    "withdrawn status recorded",
  );
  const soldRow = sqlite
    .prepare("SELECT date, price_numeric pn, price_display pd FROM price_history WHERE property_id = ? AND event = 'Sold'")
    .get(propA.id) as { date: string; pn: number; pd: string };
  assert.equal(soldRow.date, "2026-08-11", "real sale date kept, not today's detection date");
  assert.equal(soldRow.pn, 812000, "sale price kept");
  assert.equal(soldRow.pd, "Sold - $812,000", "same display string the CLI writes");

  // Re-marking replaces in place rather than accumulating.
  await post({ sold: [{ listingUrl: URL_A, price: 820000, date: "2026-08-11" }] });
  assert.equal(
    count("SELECT COUNT(*) c FROM price_history WHERE property_id = ? AND event = 'Sold'", propA.id),
    1,
    "re-marking sold does not accumulate history rows",
  );
  assert.equal(count("SELECT COUNT(*) c FROM scrape_jobs WHERE url = ?", URL_A), 1, "nor job rows");

  // --- priceObserve: appends once, then is a no-op until the price moves ---
  assert.ok(sec<{ added: number }>((await post({ priceObserve: true })).json, "priceObserve").added >= 1, "observations recorded");
  assert.equal(sec<{ added: number }>((await post({ priceObserve: true })).json, "priceObserve").added, 0, "second run adds nothing");
  await post({ properties: [{ listingUrl: URL_B, priceDisplay: "$725,000", priceNumeric: 725000 }] });
  assert.equal(
    sec<{ added: number }>((await post({ priceObserve: true })).json, "priceObserve").added,
    1,
    "a price change produces exactly one new observation",
  );

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ batch.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ batch.test FAILED:", e);
  process.exit(1);
});
