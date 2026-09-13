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

  // --- property.com.au enrichment: tri-state partial-update contract ---
  const REAL_URL = "https://www.property.com.au/vic/point-cook-3030/villiers-dr/20-pid-9472083/";
  const r1b = await post({
    properties: [{ listingUrl: URL_A, propertyComAuUrl: REAL_URL, yearBuilt: 2008 }],
  });
  assert.equal(r1b.status, 200);
  assert.equal(r1b.json.ok, true);
  const enriched = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A) as { u: string; y: number };
  assert.equal(enriched.u, REAL_URL, "propertyComAuUrl persisted via POST /api/batch");
  assert.equal(enriched.y, 2008, "yearBuilt persisted via POST /api/batch");

  const coverageBefore = await (async () => {
    const { GET } = await import("../src/app/api/batch/route");
    return (await GET()).json() as Promise<Json>;
  })();
  assert.ok(
    (sec<number>(coverageBefore, "propertyComAuUrl")) >= 1,
    "GET /api/batch coverage reflects propertyComAuUrl",
  );
  assert.ok((sec<number>(coverageBefore, "yearBuilt")) >= 1, "GET /api/batch coverage reflects yearBuilt");

  // The most important test: sending ONLY propertyComAuUrl must not null out
  // yearBuilt, and vice versa — that's the entire reason the sanitizers return
  // `undefined` (not sent) rather than `null` (explicit clear) on anything
  // that isn't itself a deliberate clear.
  await post({ properties: [{ listingUrl: URL_A, propertyComAuUrl: REAL_URL.replace("20-pid", "21-pid") }] });
  let row = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A) as { u: string; y: number };
  assert.equal(row.y, 2008, "sending only propertyComAuUrl must NOT null out yearBuilt");
  assert.ok(row.u.endsWith("21-pid-9472083/"), "propertyComAuUrl itself did update");

  await post({ properties: [{ listingUrl: URL_A, yearBuilt: 2015 }] });
  row = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A) as { u: string; y: number };
  assert.equal(row.y, 2015, "yearBuilt itself did update");
  assert.ok(row.u.endsWith("21-pid-9472083/"), "sending only yearBuilt must NOT null out propertyComAuUrl");

  // A malformed URL in one row of a batch must not 500 the request, must not
  // discard the other rows, and must leave a previously-good value on THAT row
  // intact (malformed -> undefined -> "not sent", never a silent null).
  const rMixed = await post({
    properties: [
      { listingUrl: URL_A, propertyComAuUrl: "not a url", beds: 6 },
      { listingUrl: URL_B, beds: 7 },
    ],
  });
  assert.equal(rMixed.status, 200, "a malformed enrichment field does not 500 the batch");
  assert.equal(
    sec<{ updated: number }>(rMixed.json, "properties").updated,
    2,
    "the other (good) row in the same batch is not discarded",
  );
  const afterMixed = sqlite
    .prepare("SELECT property_com_au_url u, beds b FROM properties WHERE listing_url = ?")
    .get(URL_A) as { u: string; b: number };
  assert.ok(afterMixed.u.endsWith("21-pid-9472083/"), "malformed URL left the previously-good value intact");
  assert.equal(afterMixed.b, 6, "the row's OTHER (valid) field still applied");
  // A malformed enrichment field must be VISIBLE, not just silently dropped —
  // "not sent" and "rejected" look identical in inserted/updated/errors alone,
  // which contradicts the documented "check errors, a 200 is not proof of a
  // clean apply" contract. tech-003(b).
  assert.equal(
    sec<{ rejected: number }>(rMixed.json, "properties").rejected,
    1,
    "the one malformed propertyComAuUrl is counted as rejected",
  );

  // A batch that sends nothing malformed reports zero rejected.
  const rClean = await post({ properties: [{ listingUrl: URL_B, beds: 8 }] });
  assert.equal(
    sec<{ rejected: number }>(rClean.json, "properties").rejected,
    0,
    "a clean batch reports zero rejected",
  );

  // Idempotency: re-applying the same clean payload changes nothing further.
  const beforeIdempotent = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A);
  await post({ properties: [{ listingUrl: URL_A, propertyComAuUrl: enriched.u.replace("20-pid", "21-pid"), yearBuilt: 2015 }] });
  const afterIdempotent = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A);
  assert.deepEqual(afterIdempotent, beforeIdempotent, "re-applying the same payload is a no-op");

  // Explicit `null` is a deliberate CLEAR, distinct from "not sent" (which
  // must leave the column untouched — asserted above). tests-001: this half
  // of the tri-state contract had no test anywhere in the suite. URL_A here
  // still carries real values for both columns from the idempotency block
  // just above.
  await post({ properties: [{ listingUrl: URL_A, propertyComAuUrl: null }] });
  let clearedRow = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A) as { u: string | null; y: number | null };
  assert.equal(clearedRow.u, null, "explicit null clears propertyComAuUrl");
  assert.equal(clearedRow.y, 2015, "clearing propertyComAuUrl must NOT touch yearBuilt");

  // Put propertyComAuUrl back so the mirror case starts from a real value too.
  await post({ properties: [{ listingUrl: URL_A, propertyComAuUrl: REAL_URL }] });
  await post({ properties: [{ listingUrl: URL_A, yearBuilt: null }] });
  clearedRow = sqlite
    .prepare("SELECT property_com_au_url u, year_built y FROM properties WHERE listing_url = ?")
    .get(URL_A) as { u: string | null; y: number | null };
  assert.equal(clearedRow.y, null, "explicit null clears yearBuilt");
  assert.equal(clearedRow.u, REAL_URL, "clearing yearBuilt must NOT touch propertyComAuUrl");

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

  // --- shortlist: full replace, idempotent, unknown URLs surfaced in the
  // section's own result (like `tags`' written/skipped), not `errors` --
  // setDomainShortlist never throws for an unmatched URL. ---
  const rShort1 = await post({ shortlist: { listingUrls: [URL_A] } });
  assert.equal(rShort1.status, 200, "shortlist section does not 500");
  assert.equal(rShort1.json.ok, true, "a clean shortlist run reports ok");
  assert.equal(sec<{ shortlisted: number }>(rShort1.json, "shortlist").shortlisted, 1, "URL_A shortlisted");
  assert.equal(
    sec<{ cleared: number }>(rShort1.json, "shortlist").cleared,
    1,
    "the other domain property (URL_B) is cleared",
  );
  assert.deepEqual(sec<{ unknown: string[] }>(rShort1.json, "shortlist").unknown, [], "no unknowns in a clean run");
  assert.equal(
    (sqlite.prepare("SELECT domain_shortlisted d FROM properties WHERE listing_url = ?").get(URL_A) as { d: number })
      .d,
    1,
    "domain_shortlisted actually set on URL_A",
  );

  // idempotent: re-sending the same list changes nothing further.
  const rShort2 = await post({ shortlist: { listingUrls: [URL_A] } });
  assert.equal(sec<{ shortlisted: number }>(rShort2.json, "shortlist").shortlisted, 1, "re-send: still 1 shortlisted");
  assert.equal(
    (sqlite.prepare("SELECT domain_shortlisted d FROM properties WHERE listing_url = ?").get(URL_A) as { d: number })
      .d,
    1,
    "re-send: state is unchanged, still shortlisted",
  );

  // an unknown URL is reported in the section's own result, not `errors`, and
  // does not throw or 500 the request.
  const rShort3 = await post({ shortlist: { listingUrls: [URL_A, "https://www.domain.com.au/nope-shortlist-1"] } });
  assert.equal(rShort3.status, 200, "an unknown URL in the shortlist does not 500");
  assert.deepEqual(
    sec<{ unknown: string[] }>(rShort3.json, "shortlist").unknown,
    ["https://www.domain.com.au/nope-shortlist-1"],
    "the unmatched URL is reported under shortlist.unknown",
  );
  assert.equal(sec<unknown[]>(rShort3.json, "errors").length, 0, "an unknown shortlist URL is not an `errors` row");

  // --- GET /api/batch: untaggedImages (additive coverage key, change 3) ---
  const getCoverage = async (): Promise<Json> => {
    const { GET } = await import("../src/app/api/batch/route");
    return (await GET()).json() as Promise<Json>;
  };
  interface UntaggedImagesSection {
    images: { imageId: string; propertyId: string; address: string | null; ordinal: number; localPath: string }[];
    note: string;
  }

  // Expected shape of every pre-existing key, hardcoded rather than diffed
  // against a same-run "before" snapshot: a same-run baseline would be
  // produced by the SAME (possibly regressed) code, so a uniform type change
  // would pass both sides of that comparison.
  const baseline = await getCoverage();
  // Subset of PRE_EXISTING_KEYS this test section never itself changes.
  // Checked against GROUND_TRUTH below (a direct SQL count, NOT another call
  // through GET) rather than a same-run baseline -- verified by mutation: a
  // propertyComAuUrl/yearBuilt swap in the route corrupts BOTH the baseline
  // call and every later call identically, so baseline-vs-later-call would
  // never observe a difference and the swap would go undetected. Ground
  // truth is computed independently of the code under test, so it can't be
  // corrupted the same way. totalImages/tagged/untagged/byRoom/groups are
  // excluded: inserting the untagged images below legitimately moves them.
  const VALUE_STABLE_KEYS = ["ok", "properties", "propertyComAuUrl", "yearBuilt"] as const;
  const GROUND_TRUTH: Record<(typeof VALUE_STABLE_KEYS)[number], () => unknown> = {
    ok: () => true,
    properties: () => count("SELECT COUNT(*) c FROM properties"),
    propertyComAuUrl: () => count("SELECT COUNT(*) c FROM properties WHERE property_com_au_url IS NOT NULL"),
    yearBuilt: () => count("SELECT COUNT(*) c FROM properties WHERE year_built IS NOT NULL"),
  };
  for (const k of VALUE_STABLE_KEYS) {
    assert.equal(baseline[k], GROUND_TRUTH[k](), `${k}'s value matches the DB directly, not just its type`);
  }
  const EXPECTED_TYPES: Record<string, "boolean" | "number" | "object"> = {
    ok: "boolean",
    properties: "number",
    propertyComAuUrl: "number",
    yearBuilt: "number",
    totalImages: "number",
    tagged: "number",
    untagged: "number",
    byRoom: "object",
    groups: "object", // array is typeof "object"; Array.isArray checked separately below
  };
  const PRE_EXISTING_KEYS = Object.keys(EXPECTED_TYPES) as (keyof typeof EXPECTED_TYPES)[];
  for (const k of PRE_EXISTING_KEYS) {
    assert.ok(k in baseline, `pre-existing key ${k} still present`);
    assert.equal(typeof baseline[k], EXPECTED_TYPES[k], `pre-existing key ${k} has its documented type`);
  }
  assert.ok(Array.isArray(baseline.groups), "groups is still an array");

  const propB = sqlite.prepare("SELECT id FROM properties WHERE listing_url = ?").get(URL_B) as { id: string };
  const nowU = new Date().toISOString();
  const insertImage = (id: string, propertyId: string, ordinal: number) =>
    sqlite
      .prepare(
        "INSERT INTO images (id, property_id, source_url, local_path, ordinal, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, propertyId, `https://rimh2/x/${id}.jpg`, `images/x/${id}.jpg`, ordinal, nowU);

  // Two ordinary untagged images — no image_tags row at all.
  insertImage("img_untagged_1", propB.id, 1);
  insertImage("img_untagged_2", propB.id, 2);

  const covSmall = await getCoverage();
  for (const k of PRE_EXISTING_KEYS) {
    assert.equal(
      typeof covSmall[k],
      EXPECTED_TYPES[k],
      `pre-existing key ${k} keeps its documented type (additive, not replaced)`,
    );
  }
  for (const k of VALUE_STABLE_KEYS) {
    assert.equal(covSmall[k], GROUND_TRUTH[k](), `${k}'s value is unaffected by inserting untagged images`);
  }
  const untaggedSmall = sec<UntaggedImagesSection>(covSmall, "untaggedImages");
  assert.ok(Array.isArray(untaggedSmall.images), "untaggedImages.images is an array");
  assert.equal(typeof untaggedSmall.note, "string", "untaggedImages.note is a string");
  assert.equal(untaggedSmall.images.length, 2, "both untagged images returned");
  assert.deepEqual(
    untaggedSmall.images.map((im) => im.imageId).sort(),
    ["img_untagged_1", "img_untagged_2"],
    "the two new tagless images are exactly the ones listed",
  );
  for (const im of untaggedSmall.images) {
    assert.ok(
      !("absPath" in im),
      "absPath must never be exposed over HTTP -- leaks the container's DATA_DIR path to a remote caller",
    );
  }

  // Definitional mismatch (hard constraint 3): an image_tags row that EXISTS
  // but carries a null room_type (what scripts/hero-set.ts:42's hero-only
  // insert produces) is counted by tagStatus().untagged (room_type IS NULL)
  // but is NOT "no tag row at all", so listUntaggedImages must not surface
  // it. This demonstrates the two counts really can diverge, and that `note`
  // is there to make the gap visible rather than silently under-reporting.
  insertImage("img_hero_only", propB.id, 3);
  sqlite
    .prepare("INSERT INTO image_tags (image_id, notes, tagged_by, tagged_at) VALUES (?, 'hero', 'claude-code', ?)")
    .run("img_hero_only", nowU);

  const covMismatch = await getCoverage();
  const untaggedMismatch = sec<UntaggedImagesSection>(covMismatch, "untaggedImages");
  assert.ok(
    !untaggedMismatch.images.some((im) => im.imageId === "img_hero_only"),
    "a row that HAS an image_tags row (even with room_type NULL) is not 'no tag row at all' -- excluded from the list",
  );
  assert.equal(
    untaggedMismatch.images.length,
    2,
    "listUntaggedImages is unaffected by the hero-only row: it counts by 'no tag row', not by room_type IS NULL",
  );
  assert.ok(
    (sec<number>(covMismatch, "untagged")) > untaggedMismatch.images.length,
    "tagStatus().untagged now DIVERGES from untaggedImages.images.length -- exactly the gap `note` exists to explain",
  );
  assert.match(untaggedMismatch.note, /untagged/i, "note explains the divergence rather than staying silent about it");

  // --- delete: POST /api/batch `delete` section ---
  const IMAGES_ROOT = path.join(tmp, "images");

  /** Loads a minimal fresh property via the same path `properties` uses, returns its id. */
  async function createProperty(listingUrl: string, address: string): Promise<string> {
    await post({ properties: [{ listingUrl, sourceSite: "domain", address, suburb: "Point Cook" }] });
    return (sqlite.prepare("SELECT id FROM properties WHERE listing_url = ?").get(listingUrl) as { id: string }).id;
  }

  // 1. Deletes by `ids`.
  const URL_DEL1 = "https://www.domain.com.au/10-del-st-point-cook-vic-3030-2020000100";
  const del1Id = await createProperty(URL_DEL1, "10 Del St");
  const rDel1 = await post({ delete: { ids: [del1Id] } });
  assert.equal(rDel1.status, 200, "delete by id does not 500");
  assert.equal(sec<{ deleted: number }>(rDel1.json, "delete").deleted, 1, "1 deleted by id");
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del1Id), 0, "property row gone");

  // 2. Deletes by `listingUrls`.
  const URL_DEL2 = "https://www.domain.com.au/11-del-st-point-cook-vic-3030-2020000101";
  const del2Id = await createProperty(URL_DEL2, "11 Del St");
  const rDel2 = await post({ delete: { listingUrls: [URL_DEL2] } });
  assert.equal(rDel2.status, 200, "delete by listingUrl does not 500");
  assert.equal(sec<{ deleted: number }>(rDel2.json, "delete").deleted, 1, "1 deleted by listingUrl");
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del2Id), 0, "property row gone");

  // 3. Children go with it -- the FK cascade actually firing (PRAGMA foreign_keys = ON;
  // asserted per-table rather than trusting a blanket "cascade worked").
  const URL_DEL3 = "https://www.domain.com.au/12-del-st-point-cook-vic-3030-2020000102";
  const del3Id = await createProperty(URL_DEL3, "12 Del St");
  const now3 = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO images (id, property_id, source_url, local_path, ordinal, created_at) VALUES (?,?,?,?,?,?)")
    .run("img_del3_1", del3Id, "https://rimh2/x/img_del3_1.jpg", "images/del3/1.jpg", 0, now3);
  sqlite
    .prepare("INSERT INTO image_tags (image_id, room_type, tagged_by, tagged_at, notes) VALUES (?,?,?,?,?)")
    .run("img_del3_1", "kitchen", "claude-code", now3, null);
  sqlite
    .prepare("INSERT INTO property_ratings (property_id, profile, vibe, updated_at) VALUES (?,?,?,?)")
    .run(del3Id, "gerhard", "like", now3);
  sqlite
    .prepare(
      "INSERT INTO price_history " +
        "(id, property_id, date, event, price_display, price_numeric, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run("ph_del3_1", del3Id, "2026-01-01", "Listed", "$800,000", 800000, now3);
  sqlite
    .prepare("INSERT INTO property_changes (id, property_id, field, before, after, created_at) VALUES (?,?,?,?,?,?)")
    .run("pc_del3_1", del3Id, "price_display", null, "$800,000", now3);
  sqlite
    .prepare("INSERT INTO shares (id, property_id, from_profile, to_profile, created_at) VALUES (?,?,?,?,?)")
    .run("sh_del3_1", del3Id, "gerhard", "johanita", now3);
  // Second-level cascade: property -> images -> similarity_group_members,
  // via image_id (not property_id directly) -- the one child table case 3
  // otherwise never exercises.
  sqlite
    .prepare("INSERT INTO similarity_groups (id, label, created_at) VALUES (?,?,?)")
    .run("grp_del3_1", "kitchen", now3);
  sqlite
    .prepare("INSERT INTO similarity_group_members (group_id, image_id, added_at) VALUES (?,?,?)")
    .run("grp_del3_1", "img_del3_1", now3);

  const rDel3 = await post({ delete: { ids: [del3Id] } });
  assert.equal(sec<{ deleted: number }>(rDel3.json, "delete").deleted, 1, "property with children deletes");
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del3Id), 0, "property row gone");
  assert.equal(count("SELECT COUNT(*) c FROM images WHERE property_id = ?", del3Id), 0, "images cascaded");
  assert.equal(count("SELECT COUNT(*) c FROM image_tags WHERE image_id = ?", "img_del3_1"), 0, "image_tags cascaded");
  assert.equal(count("SELECT COUNT(*) c FROM property_ratings WHERE property_id = ?", del3Id), 0, "ratings cascaded");
  assert.equal(
    count("SELECT COUNT(*) c FROM price_history WHERE property_id = ?", del3Id),
    0,
    "price_history cascaded",
  );
  assert.equal(
    count("SELECT COUNT(*) c FROM property_changes WHERE property_id = ?", del3Id),
    0,
    "property_changes cascaded",
  );
  assert.equal(count("SELECT COUNT(*) c FROM shares WHERE property_id = ?", del3Id), 0, "shares cascaded");
  assert.equal(
    count("SELECT COUNT(*) c FROM similarity_group_members WHERE image_id = ?", "img_del3_1"),
    0,
    "similarity_group_members cascaded via image_id (second-level cascade)",
  );

  // 4. scrape_jobs is the special case: the one FK with no ON DELETE action.
  // Detach (property_id -> NULL), never delete -- this is the case a naive
  // "just cascade everything" implementation breaks in production.
  const URL_DEL4 = "https://www.domain.com.au/13-del-st-point-cook-vic-3030-2020000103";
  const del4Id = await createProperty(URL_DEL4, "13 Del St");
  const now4 = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run("job_del4_1", URL_DEL4, "done", del4Id, now4, now4);

  const rDel4 = await post({ delete: { ids: [del4Id] } });
  assert.equal(rDel4.status, 200, "a property with an active scrape_jobs row does not 500 the delete");
  assert.equal(
    sec<{ deleted: number }>(rDel4.json, "delete").deleted,
    1,
    "property with a scrape_jobs row still deletes -- would FK-fail without the detach",
  );
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del4Id), 0, "property row gone");
  const jobRow4 = sqlite.prepare("SELECT property_id p FROM scrape_jobs WHERE id = ?").get("job_del4_1") as {
    p: string | null;
  };
  assert.equal(jobRow4.p, null, "scrape_jobs row detached (property_id NULL), not deleted");
  assert.equal(count("SELECT COUNT(*) c FROM scrape_jobs WHERE id = ?", "job_del4_1"), 1, "job row itself survives");

  // 5. Idempotent: unknown refs land in notFound, add nothing to errors, never throw.
  const rDelUnknown = await post({
    delete: { ids: ["no-such-id-xyz"], listingUrls: ["https://www.domain.com.au/no-such-listing-xyz"] },
  });
  assert.equal(rDelUnknown.status, 200, "deleting unknown refs does not throw/500");
  assert.deepEqual(
    sec<{ notFound: string[] }>(rDelUnknown.json, "delete").notFound.slice().sort(),
    ["https://www.domain.com.au/no-such-listing-xyz", "no-such-id-xyz"].sort(),
    "both unknown refs reported in notFound",
  );
  assert.equal(sec<{ deleted: number }>(rDelUnknown.json, "delete").deleted, 0, "nothing deleted for unknown refs");
  assert.equal(sec<unknown[]>(rDelUnknown.json, "errors").length, 0, "unknown refs are not errors rows");

  // 5b. Re-sending the same delete twice is a no-op the second time.
  const URL_DEL5 = "https://www.domain.com.au/14-del-st-point-cook-vic-3030-2020000104";
  const del5Id = await createProperty(URL_DEL5, "14 Del St");
  const rDel5First = await post({ delete: { ids: [del5Id] } });
  assert.equal(sec<{ deleted: number }>(rDel5First.json, "delete").deleted, 1, "first send deletes the property");
  const rDel5Second = await post({ delete: { ids: [del5Id] } });
  assert.equal(
    sec<{ deleted: number }>(rDel5Second.json, "delete").deleted,
    0,
    "re-sending the same delete a second time deletes nothing further",
  );
  assert.deepEqual(
    sec<{ notFound: string[] }>(rDel5Second.json, "delete").notFound,
    [del5Id],
    "the second send reports the id as notFound",
  );
  assert.equal(sec<unknown[]>(rDel5Second.json, "errors").length, 0, "notFound on re-send is not an errors row");

  // 6. Ordering: `delete` applies before `properties` in the SAME payload, and
  // key order in the JS object literal must not change that -- the route
  // reads body.delete / body.properties directly, it does not iterate keys.
  const URL_DEL6 = "https://www.domain.com.au/15-del-st-point-cook-vic-3030-2020000105";
  const del6IdBefore = await createProperty(URL_DEL6, "15 Del St");
  const rDel6a = await post({
    delete: { listingUrls: [URL_DEL6] },
    properties: [{ listingUrl: URL_DEL6, sourceSite: "domain", address: "15 Del St Re-added" }],
  });
  assert.equal(rDel6a.status, 200, "delete-then-reload in one payload does not 500");
  const afterA = sqlite.prepare("SELECT id, address FROM properties WHERE listing_url = ?").get(URL_DEL6) as
    | { id: string; address: string }
    | undefined;
  assert.ok(afterA, "property EXISTS afterwards -- deleted first, then re-added, not left missing");
  assert.equal(afterA!.address, "15 Del St Re-added", "the surviving row is the newly-loaded one");
  assert.notEqual(afterA!.id, del6IdBefore, "fresh id proves the old row really was deleted before the reload");

  // 7. Image directory removal.
  const URL_DEL7 = "https://www.domain.com.au/16-del-st-point-cook-vic-3030-2020000106";
  const del7Id = await createProperty(URL_DEL7, "16 Del St");
  const del7ImgDir = path.join(IMAGES_ROOT, del7Id);
  fs.mkdirSync(del7ImgDir, { recursive: true });
  fs.writeFileSync(path.join(del7ImgDir, "1.jpg"), "fake-image-bytes");
  assert.ok(fs.existsSync(del7ImgDir), "sanity: image dir exists before delete");
  const rDel7 = await post({ delete: { ids: [del7Id] } });
  assert.equal(sec<{ deleted: number }>(rDel7.json, "delete").deleted, 1);
  assert.ok(!fs.existsSync(del7ImgDir), "image directory removed after delete");
  assert.equal(sec<unknown[]>(rDel7.json, "errors").length, 0, "a clean image removal is not an errors row");

  // 8. Transaction atomicity: force the property-row DELETE to fail AFTER the
  // scrape_jobs detach has already run in the same transaction, using a
  // TEMP TRIGGER (test-only SQLite object -- no production code touched) that
  // RAISEs on the specific row. Proves the detach rolls back too: if the two
  // statements were not one transaction, the detach would survive the DELETE
  // failing and job_del8_1.property_id would be NULL afterwards.
  const URL_DEL8 = "https://www.domain.com.au/17-del-st-point-cook-vic-3030-2020000107";
  const del8Id = await createProperty(URL_DEL8, "17 Del St");
  const now8 = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO scrape_jobs (id, url, status, property_id, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run("job_del8_1", URL_DEL8, "done", del8Id, now8, now8);

  sqlite.exec(
    `CREATE TEMP TRIGGER trg_block_del8 BEFORE DELETE ON properties WHEN OLD.id = '${del8Id}' ` +
      `BEGIN SELECT RAISE(ABORT, 'test: forced failure to prove atomicity'); END;`,
  );

  const { deleteProperty } = await import("../src/db/queries/delete");
  let del8Threw = false;
  try {
    deleteProperty(del8Id);
  } catch {
    del8Threw = true;
  }
  assert.ok(del8Threw, "the forced trigger failure propagates out of deleteProperty rather than being swallowed");
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE id = ?", del8Id),
    1,
    "property row still present -- the failed delete rolled back",
  );
  const jobAfter8 = sqlite.prepare("SELECT property_id p FROM scrape_jobs WHERE id = ?").get("job_del8_1") as {
    p: string | null;
  };
  assert.equal(
    jobAfter8.p,
    del8Id,
    "scrape_jobs detach rolled back together with the failed delete -- one transaction, not two independent writes",
  );

  sqlite.exec("DROP TRIGGER trg_block_del8");
  // With the forced failure removed, the same delete now succeeds normally.
  const rDel8 = await post({ delete: { ids: [del8Id] } });
  assert.equal(
    sec<{ deleted: number }>(rDel8.json, "delete").deleted,
    1,
    "delete succeeds once the forced failure trigger is gone",
  );

  // 9. REGRESSION: a per-ref failure on the delete path must not escape as an
  // unhandled 500 that discards the rest of the payload. `{}` bound directly
  // as a SQL parameter throws `RangeError: Too few parameter values were
  // provided` from better-sqlite3 -- this must go through the HTTP post()
  // path, not a direct deleteProperty() call, because that's exactly what let
  // this slip past case 8 above.
  const URL_DEL9A = "https://www.domain.com.au/18-del-st-point-cook-vic-3030-2020000108";
  const URL_DEL9B = "https://www.domain.com.au/19-del-st-point-cook-vic-3030-2020000109";
  const URL_DEL9C = "https://www.domain.com.au/20-del-st-point-cook-vic-3030-2020000110";
  const del9AId = await createProperty(URL_DEL9A, "18 Del St");
  const del9BId = await createProperty(URL_DEL9B, "19 Del St");

  const rDel9 = await post({
    delete: { ids: [del9AId, {}, del9BId] },
    properties: [{ listingUrl: URL_DEL9C, sourceSite: "domain", address: "20 Del St" }],
  });
  assert.equal(rDel9.status, 200, "a bad-shape ref in delete.ids does not 500 the whole request");
  assert.equal(
    sec<{ deleted: number }>(rDel9.json, "delete").deleted,
    2,
    "both valid refs around the bad one are still deleted -- containment, not an all-or-nothing abort",
  );
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del9AId), 0, "idA deleted");
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del9BId), 0, "idB deleted");
  assert.ok(
    sec<{ section: string }[]>(rDel9.json, "errors").some((e) => e.section === "delete"),
    "the bad-shape ref is reported under errors, section delete -- not swallowed, not a throw",
  );
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE listing_url = ?", URL_DEL9C),
    1,
    "the properties section in the SAME payload still applied despite the bad delete ref",
  );

  // 10. REGRESSION: a re-send must be able to clear an image directory that
  // failed to remove on a PRIOR send. fs.rmSync is patched (and restored
  // immediately after, success or failure) to fail only for this directory --
  // property ids are read via `fs.rmSync(dir, ...)` property access, not a
  // destructured import, so the patch on the shared module object is observed.
  const URL_DEL10 = "https://www.domain.com.au/21-del-st-point-cook-vic-3030-2020000111";
  const del10Id = await createProperty(URL_DEL10, "21 Del St");
  const del10ImgDir = path.join(IMAGES_ROOT, del10Id);
  fs.mkdirSync(del10ImgDir, { recursive: true });
  fs.writeFileSync(path.join(del10ImgDir, "1.jpg"), "fake-image-bytes");

  // `import fs from "node:fs"` elsewhere in this codebase binds to this same
  // mutable default-export object -- patching a property on it (rather than
  // the frozen ESM namespace `fsMod` itself) is what makes delete.ts's
  // `fs.rmSync(...)` property lookup observe the patch.
  const fsMod = (await import("node:fs")).default as typeof fs;
  const originalRmSync = fsMod.rmSync;
  fsMod.rmSync = (p: fs.PathLike, opts?: fs.RmOptions) => {
    if (p === del10ImgDir) throw new Error("simulated fs failure");
    return originalRmSync(p, opts as fs.RmOptions & { recursive: true });
  };
  let rDel10First: { status: number; json: Json };
  try {
    rDel10First = await post({ delete: { ids: [del10Id] } });
  } finally {
    fsMod.rmSync = originalRmSync;
  }
  assert.equal(
    sec<{ deleted: number }>(rDel10First.json, "delete").deleted,
    1,
    "row deleted on first send despite the fs failure",
  );
  assert.ok(fs.existsSync(del10ImgDir), "orphan directory survives the failed removal");
  assert.ok(
    sec<{ section: string; ref: string }[]>(rDel10First.json, "errors").some(
      (e) => e.section === "delete" && e.ref === del10Id,
    ),
    "the fs failure is reported in errors",
  );

  // Re-send: the ref is now notFound (row already gone), but the filesystem
  // step must still run -- that is the whole point of this regression.
  const rDel10Second = await post({ delete: { ids: [del10Id] } });
  assert.equal(
    sec<{ deleted: number }>(rDel10Second.json, "delete").deleted,
    0,
    "second send: nothing left in the DB to delete",
  );
  assert.deepEqual(
    sec<{ notFound: string[] }>(rDel10Second.json, "delete").notFound,
    [del10Id],
    "second send: id reported notFound",
  );
  assert.ok(!fs.existsSync(del10ImgDir), "the orphan directory is finally removed on re-send");
  assert.equal(
    sec<unknown[]>(rDel10Second.json, "errors").length,
    0,
    "a clean removal on re-send is not an errors row",
  );

  // 11. Path guard: an id containing a path separator must not let delete
  // reach outside its OWN top-level directory. `startsWith(root + sep)`
  // confines to the subtree, not a direct child, so id = "<victimId>/nested"
  // still passes it and recursively destroys part of a DIFFERENT property's
  // files while that property's own row survives untouched.
  const URL_DEL11 = "https://www.domain.com.au/22-del-st-point-cook-vic-3030-2020000112";
  const victim11Id = await createProperty(URL_DEL11, "22 Del St");
  const victim11Dir = path.join(IMAGES_ROOT, victim11Id);
  const victim11NestedDir = path.join(victim11Dir, "nested");
  fs.mkdirSync(victim11NestedDir, { recursive: true });
  fs.writeFileSync(path.join(victim11Dir, "keep.jpg"), "victim's own photo");
  fs.writeFileSync(path.join(victim11NestedDir, "marker.txt"), "nested marker");

  const maliciousId11 = `${victim11Id}/nested`;
  const now11 = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(maliciousId11, "domain", "https://www.domain.com.au/malicious-path-traversal-11", now11, now11, now11);

  const rDel11 = await post({ delete: { ids: [maliciousId11] } });
  assert.equal(sec<{ deleted: number }>(rDel11.json, "delete").deleted, 1, "the malicious row itself is deleted");
  assert.ok(
    fs.existsSync(victim11NestedDir) && fs.existsSync(path.join(victim11NestedDir, "marker.txt")),
    "the OTHER property's nested subfolder survives -- confined to a direct child of IMAGES_DIR",
  );
  assert.ok(fs.existsSync(path.join(victim11Dir, "keep.jpg")), "the victim property's own photo is untouched");
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE id = ?", victim11Id),
    1,
    "the victim property's row is untouched",
  );
  assert.equal(
    sec<unknown[]>(rDel11.json, "errors").length,
    0,
    "the skipped fs step (not a direct child) is not an errors row",
  );

  // 12. `listingUrls` resolves `listing_url` ONLY, never `alt_listing_url` --
  // deliberately unlike sold/withdrawn/priceObserve. A ref that is only some
  // row's alt_listing_url must come back notFound, delete nothing, and leave
  // that row untouched: resolving a destructive ref through an alias can't be
  // made idempotent (a re-send after a successful delete could match, and
  // destroy, a different row that only carries the ref as its alt URL).
  const URL_DEL12_DOMAIN = "https://www.domain.com.au/23-del-st-point-cook-vic-3030-2020000113";
  const URL_DEL12_REA = "https://www.realestate.com.au/property-house-vic-point+cook-987654321";
  const del12Id = await createProperty(URL_DEL12_DOMAIN, "23 Del St");
  sqlite.prepare("UPDATE properties SET alt_listing_url = ? WHERE id = ?").run(URL_DEL12_REA, del12Id);

  const rDel12 = await post({ delete: { listingUrls: [URL_DEL12_REA] } });
  assert.equal(
    sec<{ deleted: number }>(rDel12.json, "delete").deleted,
    0,
    "a ref that is only some row's alt_listing_url resolves to nothing",
  );
  assert.deepEqual(
    sec<{ notFound: string[] }>(rDel12.json, "delete").notFound,
    [URL_DEL12_REA],
    "the alt-only ref is reported notFound, not resolved",
  );
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE id = ?", del12Id),
    1,
    "the row survives -- it was never named by its own listing_url",
  );

  // 13. REGRESSION: a `sub/../<victimId>` id matches no row (notFound), but
  // path.resolve collapses it to a single path segment equal to <victimId>,
  // so `dirname(dir) === root` alone would still pass and let the fs step
  // destroy a DIFFERENT property's real image directory with no DB row
  // involved and no error reported. Requiring `basename(id) === id` BEFORE
  // resolving closes this without restoring the ids pre-check SELECT.
  const URL_DEL13 = "https://www.domain.com.au/24-del-st-point-cook-vic-3030-2020000114";
  const victim13Id = await createProperty(URL_DEL13, "24 Del St");
  const victim13Dir = path.join(IMAGES_ROOT, victim13Id);
  fs.mkdirSync(victim13Dir, { recursive: true });
  fs.writeFileSync(path.join(victim13Dir, "keep.jpg"), "victim's own photo");

  const maliciousId13 = `sub/../${victim13Id}`;
  const rDel13 = await post({ delete: { ids: [maliciousId13] } });
  assert.equal(sec<{ deleted: number }>(rDel13.json, "delete").deleted, 0, "the traversal ref matches no row");
  assert.deepEqual(
    sec<{ notFound: string[] }>(rDel13.json, "delete").notFound,
    [maliciousId13],
    "the traversal ref is reported notFound",
  );
  assert.ok(
    fs.existsSync(victim13Dir) && fs.existsSync(path.join(victim13Dir, "keep.jpg")),
    "the victim's OWN image directory survives -- the traversal ref must not reach it",
  );
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE id = ?", victim13Id),
    1,
    "the victim property's row is untouched",
  );

  // 14. Same guard also covers a nested id -- "<victimId>/nested" matches no
  // row either; costs nothing to check the fs step leaves it alone too.
  const URL_DEL14 = "https://www.domain.com.au/25-del-st-point-cook-vic-3030-2020000115";
  const victim14Id = await createProperty(URL_DEL14, "25 Del St");
  const victim14Dir = path.join(IMAGES_ROOT, victim14Id);
  fs.mkdirSync(victim14Dir, { recursive: true });
  fs.writeFileSync(path.join(victim14Dir, "keep.jpg"), "victim's own photo");

  const maliciousId14 = `${victim14Id}/nested`;
  const rDel14 = await post({ delete: { ids: [maliciousId14] } });
  assert.equal(sec<{ deleted: number }>(rDel14.json, "delete").deleted, 0, "the nested ref matches no row");
  assert.ok(
    fs.existsSync(victim14Dir) && fs.existsSync(path.join(victim14Dir, "keep.jpg")),
    "the victim's OWN image directory survives",
  );

  // 17. REGRESSION: a non-string element reported via `String(x)` can itself
  // throw -- `TypeError: Cannot convert object to primitive value` for a
  // JSON-constructible object like `{"toString":1}`, whose `toString` is a
  // non-callable data property. `stringRefs` runs OUTSIDE `runById`'s
  // try/catch, so the throw escapes `deletePropertiesByRef` and the
  // uncontained call in the route: HTTP 500 with no body, after part of the
  // delete already committed, every later section of the SAME payload
  // discarded -- the exact hole sec-001/round-1 closed, reopened.
  const URL_DEL17 = "https://www.domain.com.au/29-del-st-point-cook-vic-3030-2020000119";
  const URL_DEL17_NEW = "https://www.domain.com.au/30-del-st-point-cook-vic-3030-2020000120";
  const del17Id = await createProperty(URL_DEL17, "29 Del St");

  const rDel17 = await post({
    delete: { ids: [del17Id], listingUrls: [{ toString: 1 }] },
    properties: [{ listingUrl: URL_DEL17_NEW, sourceSite: "domain", address: "30 Del St" }],
  });
  assert.equal(rDel17.status, 200, "a non-string element that itself throws on String() must not 500 the batch");
  assert.equal(sec<{ deleted: number }>(rDel17.json, "delete").deleted, 1, "the valid id ref still deletes");
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE id = ?", del17Id),
    0,
    "the valid id's property row is gone",
  );
  assert.ok(
    sec<{ section: string }[]>(rDel17.json, "errors").some((e) => e.section === "delete"),
    "the throwing ref is reported under errors, section delete -- not an uncaught 500",
  );
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE listing_url = ?", URL_DEL17_NEW),
    1,
    "the properties section in the SAME payload still applied despite the throwing delete ref",
  );

  // 18. The identity guard: `id = "."` and `id = ".."` must not reach the
  // filesystem step at all. Without the guard, `path.resolve(root, ".")`
  // collapses to `root` itself, and the fs step -- which runs UNCONDITIONALLY
  // -- would `fs.rmSync(root, {recursive: true})`, destroying every
  // property's images in one call. A sibling property with a real image
  // directory proves it: it must survive both sends untouched.
  const URL_DEL18_SIBLING = "https://www.domain.com.au/31-del-st-point-cook-vic-3030-2020000121";
  const sibling18Id = await createProperty(URL_DEL18_SIBLING, "31 Del St");
  const sibling18Dir = path.join(IMAGES_ROOT, sibling18Id);
  fs.mkdirSync(sibling18Dir, { recursive: true });
  fs.writeFileSync(path.join(sibling18Dir, "keep.jpg"), "sibling's own photo");
  assert.ok(fs.existsSync(IMAGES_ROOT), "sanity: IMAGES_ROOT exists before the guard cases run");

  const rDel18Dot = await post({ delete: { ids: ["."] } });
  assert.equal(rDel18Dot.status, 200, "id '.' does not 500");
  assert.equal(sec<{ deleted: number }>(rDel18Dot.json, "delete").deleted, 0, "'.' matches no row");
  assert.ok(fs.existsSync(IMAGES_ROOT), "IMAGES_ROOT itself survives id '.'");
  assert.ok(
    fs.existsSync(sibling18Dir) && fs.existsSync(path.join(sibling18Dir, "keep.jpg")),
    "the sibling's OWN image directory survives id '.'",
  );

  const rDel18DotDot = await post({ delete: { ids: [".."] } });
  assert.equal(rDel18DotDot.status, 200, "id '..' does not 500");
  assert.equal(sec<{ deleted: number }>(rDel18DotDot.json, "delete").deleted, 0, "'..' matches no row");
  assert.ok(fs.existsSync(IMAGES_ROOT), "IMAGES_ROOT itself survives id '..'");
  assert.ok(
    fs.existsSync(sibling18Dir) && fs.existsSync(path.join(sibling18Dir, "keep.jpg")),
    "the sibling's OWN image directory survives id '..'",
  );

  // 19. The per-ref try/catch in `runById` (inside `deletePropertiesByRef`)
  // must contain a genuine throw from `deleteProperty` on a VALID, resolved
  // string id -- distinct from case 9, whose `{}` element never reaches
  // `runById` at all (it is filtered a step earlier by `stringRefs`). Force
  // the throw with the same TEMP TRIGGER technique case 8 uses, through
  // `post()`, alongside another valid ref and a `properties` entry in the SAME
  // payload -- proving containment, not just that the exception exists.
  const URL_DEL19_BLOCKED = "https://www.domain.com.au/32-del-st-point-cook-vic-3030-2020000122";
  const URL_DEL19_OTHER = "https://www.domain.com.au/33-del-st-point-cook-vic-3030-2020000123";
  const URL_DEL19_NEW = "https://www.domain.com.au/34-del-st-point-cook-vic-3030-2020000124";
  const del19BlockedId = await createProperty(URL_DEL19_BLOCKED, "32 Del St");
  const del19OtherId = await createProperty(URL_DEL19_OTHER, "33 Del St");

  sqlite.exec(
    `CREATE TEMP TRIGGER trg_block_del19 BEFORE DELETE ON properties WHEN OLD.id = '${del19BlockedId}' ` +
      `BEGIN SELECT RAISE(ABORT, 'test: forced failure to prove the per-ref try/catch'); END;`,
  );

  const rDel19 = await post({
    delete: { ids: [del19BlockedId, del19OtherId] },
    properties: [{ listingUrl: URL_DEL19_NEW, sourceSite: "domain", address: "34 Del St" }],
  });
  sqlite.exec("DROP TRIGGER trg_block_del19");

  assert.equal(rDel19.status, 200, "a genuine throw on one ref does not 500 the whole request");
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE id = ?", del19BlockedId),
    1,
    "the triggered ref's property survives -- the failed delete rolled back",
  );
  assert.equal(
    sec<{ deleted: number }>(rDel19.json, "delete").deleted,
    1,
    "the OTHER valid ref still deletes despite the triggered one throwing",
  );
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del19OtherId), 0, "the other ref's row is gone");
  assert.ok(
    sec<{ section: string; ref: string }[]>(rDel19.json, "errors").some(
      (e) => e.section === "delete" && e.ref === del19BlockedId,
    ),
    "the triggered ref lands in errors under section delete",
  );
  assert.equal(
    count("SELECT COUNT(*) c FROM properties WHERE listing_url = ?", URL_DEL19_NEW),
    1,
    "the properties section in the SAME payload still applied despite the per-ref throw",
  );

  // 20. A non-array `ids`/`listingUrls` must be reported loudly, the same way
  // a bad-shape ELEMENT already is -- not silently treated as empty. The
  // route-level guard also runs whenever `body.delete` is present, so a
  // wrong-shaped container isn't dropped before it ever reaches the module
  // that reports it.
  const URL_DEL20 = "https://www.domain.com.au/35-del-st-point-cook-vic-3030-2020000125";
  const del20Id = await createProperty(URL_DEL20, "35 Del St");

  const rDel20String = await post({ delete: { ids: del20Id } });
  assert.equal(rDel20String.status, 200, "a string ids container does not 500");
  assert.equal(
    sec<{ deleted: number }>(rDel20String.json, "delete").deleted,
    0,
    "nothing deleted from a bad container",
  );
  assert.ok(
    sec<{ section: string }[]>(rDel20String.json, "errors").some((e) => e.section === "delete"),
    "a non-array ids container is reported under errors, section delete",
  );
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del20Id), 1, "the property is untouched");

  const rDel20Obj = await post({ delete: { ids: { "0": del20Id } } });
  assert.equal(rDel20Obj.status, 200, "a plain-object ids container does not 500");
  assert.ok("delete" in rDel20Obj.json, "the delete section runs and reports, rather than being skipped entirely");
  assert.equal(sec<{ deleted: number }>(rDel20Obj.json, "delete").deleted, 0, "nothing deleted from a bad container");
  assert.ok(
    sec<{ section: string }[]>(rDel20Obj.json, "errors").some((e) => e.section === "delete"),
    "a non-array-like ids container is reported under errors, section delete",
  );
  assert.equal(count("SELECT COUNT(*) c FROM properties WHERE id = ?", del20Id), 1, "still untouched");

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
