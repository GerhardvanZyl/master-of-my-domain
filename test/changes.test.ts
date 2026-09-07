/**
 * Offline test of src/db/queries/changes.ts — the append-only property-change
 * diff log. Exercises the real write paths (loadProperties, markSold,
 * markWithdrawn) rather than writing property_changes rows by hand, since the
 * point is that those paths log correctly, not that the table can hold a row.
 * Temp DB, set BEFORE importing app modules — same pattern as batch.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-changes-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

const URL_A = "https://www.domain.com.au/1-alpha-st-point-cook-vic-3030-2020000001";
const URL_B = "https://www.domain.com.au/2-beta-st-point-cook-vic-3030-2020000002";
const URL_C = "https://www.domain.com.au/3-gamma-st-point-cook-vic-3030-2020000003";
const URL_D = "https://www.domain.com.au/4-delta-st-point-cook-vic-3030-2020000004";
const URL_E = "https://www.domain.com.au/5-epsilon-st-point-cook-vic-3030-2020000005";
const URL_F_DOMAIN = "https://www.domain.com.au/6-zeta-st-point-cook-vic-3030-2020000006";
const URL_F_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000006";
const URL_G = "https://www.domain.com.au/7-eta-st-point-cook-vic-3030-2020000007";
const URL_H = "https://www.domain.com.au/8-theta-st-point-cook-vic-3030-2020000008";
const URL_I_DOMAIN = "https://www.domain.com.au/9-iota-st-point-cook-vic-3030-2020000009";
const URL_I_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000009";
const URL_J_DOMAIN = "https://www.domain.com.au/10-kappa-st-point-cook-vic-3030-2020000010";
const URL_J_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000010";
// Same house, same site, two URLs — a relisting, not a second source.
const URL_K_OLD = "https://www.domain.com.au/12-mu-st-point-cook-vic-3030-2020000011";
const URL_K_NEW = "https://www.domain.com.au/12-mu-st-point-cook-vic-3030-2020000012";
const URL_L_DOMAIN = "https://www.domain.com.au/13-nu-st-point-cook-vic-3030-2020000013";
const URL_L_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000013";
const URL_M_DOMAIN = "https://www.domain.com.au/14-xi-st-point-cook-vic-3030-2020000014";
const URL_M_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000014";
const URL_N_DOMAIN = "https://www.domain.com.au/15-omicron-st-point-cook-vic-3030-2020000015";
const URL_N_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000015";
const URL_O_DOMAIN = "https://www.domain.com.au/16-pi-st-point-cook-vic-3030-2020000016";
const URL_O_REA = "https://www.realestate.com.au/property-house-vic-point+cook-2020000016";

// Smallest possible valid PNG (1x1, transparent) -- fed to a stubbed
// global.fetch so syncImages's real code path (download, hash, probe
// dimensions, write to disk) runs offline, without a mocked syncImages.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { loadProperties } = await import("../src/db/queries/load");
  const { markSold, markWithdrawn } = await import("../src/db/queries/status");
  const { snapshotProperty, recordPropertyChanges } = await import("../src/db/queries/changes");
  const { getProperty, getSaleStatus, listProperties } = await import("../src/db/queries/properties");
  const { upsertProperty } = await import("../src/scrape/persist");
  const { syncImages } = await import("../src/scrape/images");
  migrate();

  const changeCount = (propertyId?: string) =>
    (propertyId
      ? sqlite.prepare("SELECT COUNT(*) c FROM property_changes WHERE property_id = ?").get(propertyId)
      : sqlite.prepare("SELECT COUNT(*) c FROM property_changes").get()) as { c: number };
  const idFor = (url: string) =>
    (sqlite.prepare("SELECT id FROM properties WHERE listing_url = ?").get(url) as { id: string }).id;
  const rowsFor = (propertyId: string, field: string) =>
    sqlite
      .prepare(
        "SELECT before b, after a FROM property_changes WHERE property_id = ? AND field = ? ORDER BY created_at",
      )
      .all(propertyId, field) as { b: string | null; a: string | null }[];

  // -------------------------------------------------------------------
  // THE single most important test: a no-op reload adds ZERO rows.
  // -------------------------------------------------------------------
  const payload = [
    {
      listingUrl: URL_A,
      sourceSite: "domain",
      address: "1 Alpha St",
      beds: 4,
      baths: 2,
      parking: 2,
      priceDisplay: "$800,000",
      priceNumeric: 800000,
      landSizeSqm: 500,
      propertyType: "House",
      agentName: "Jane Agent",
      agencyName: "Ray White",
      nextInspection: "2026-09-10T10:00:00.000Z",
    },
  ];
  loadProperties(payload);
  const afterFirst = changeCount().c;
  assert.equal(afterFirst, 1, "brand-new property logs exactly its one synthetic listing row");
  loadProperties(payload); // identical payload, second time
  assert.equal(
    changeCount().c,
    afterFirst,
    "re-running loadProperties with an IDENTICAL payload adds zero property_changes rows",
  );

  // -------------------------------------------------------------------
  // A brand-new property produces exactly ONE row: listing / null / "new".
  // -------------------------------------------------------------------
  loadProperties([{ listingUrl: URL_B, sourceSite: "domain", address: "2 Beta St", beds: 3 }]);
  const idB = idFor(URL_B);
  const listingRows = rowsFor(idB, "listing");
  assert.equal(listingRows.length, 1, "exactly one row for a brand-new property");
  assert.equal(listingRows[0].b, null, "listing row before is null");
  assert.equal(listingRows[0].a, "new", 'listing row after is "new"');
  assert.equal(changeCount(idB).c, 1, "no per-field rows alongside the synthetic listing row");

  // -------------------------------------------------------------------
  // Changing several tracked fields at once: one row per changed field,
  // correct before/after. Covers price, beds, next inspection, address,
  // agent — plus the rest of the tracked set in the same load.
  // -------------------------------------------------------------------
  const idA = idFor(URL_A);
  const beforeCountA = changeCount(idA).c;
  loadProperties([
    {
      listingUrl: URL_A,
      priceDisplay: "$820,000",
      priceNumeric: 820000,
      beds: 5,
      baths: 3,
      parking: 3,
      landSizeSqm: 550,
      propertyType: "Townhouse",
      address: "1 Alpha St (updated)",
      agentName: "John Agent",
      agencyName: "Barry Plant",
      nextInspection: "2026-09-17T10:00:00.000Z",
    },
  ]);
  const newRowsA = changeCount(idA).c - beforeCountA;
  assert.equal(newRowsA, 11, "one row per changed tracked field (11 non-derived fields all changed)");
  assert.deepEqual(rowsFor(idA, "price_display")[0], { b: "$800,000", a: "$820,000" });
  assert.deepEqual(rowsFor(idA, "price_numeric")[0], { b: "800000", a: "820000" });
  assert.deepEqual(rowsFor(idA, "beds")[0], { b: "4", a: "5" });
  assert.deepEqual(rowsFor(idA, "next_inspection")[0], {
    b: "2026-09-10T10:00:00.000Z",
    a: "2026-09-17T10:00:00.000Z",
  });
  assert.deepEqual(rowsFor(idA, "address")[0], { b: "1 Alpha St", a: "1 Alpha St (updated)" });
  assert.deepEqual(rowsFor(idA, "agent_name")[0], { b: "Jane Agent", a: "John Agent" });
  assert.deepEqual(rowsFor(idA, "agency_name")[0], { b: "Ray White", a: "Barry Plant" });
  assert.deepEqual(rowsFor(idA, "baths")[0], { b: "2", a: "3" });
  assert.deepEqual(rowsFor(idA, "parking")[0], { b: "2", a: "3" });
  assert.deepEqual(rowsFor(idA, "land_size_sqm")[0], { b: "500", a: "550" });
  assert.deepEqual(rowsFor(idA, "property_type")[0], { b: "House", a: "Townhouse" });

  // -------------------------------------------------------------------
  // Changing an UNTRACKED field (description, the field the user explicitly
  // asked to be ignored) produces ZERO rows.
  // -------------------------------------------------------------------
  const beforeCountA2 = changeCount(idA).c;
  loadProperties([{ listingUrl: URL_A, description: "A completely rewritten marketing blurb." }]);
  assert.equal(
    changeCount(idA).c,
    beforeCountA2,
    "changing ONLY description (untracked, user-excluded) adds zero rows",
  );

  // -------------------------------------------------------------------
  // null -> value, and value -> null, both log correctly.
  // -------------------------------------------------------------------
  loadProperties([{ listingUrl: URL_C, sourceSite: "domain", address: "3 Gamma St", nextInspection: null }]);
  const idC = idFor(URL_C);
  assert.equal(changeCount(idC).c, 1, "creation still logs only the synthetic listing row, even with an explicit null");

  loadProperties([{ listingUrl: URL_C, nextInspection: "2026-09-20T10:00:00.000Z" }]);
  const nullToValue = rowsFor(idC, "next_inspection");
  assert.equal(nullToValue.length, 1, "null -> value logs exactly one row");
  assert.deepEqual(nullToValue[0], { b: null, a: "2026-09-20T10:00:00.000Z" }, "null -> value before/after");

  loadProperties([{ listingUrl: URL_C, nextInspection: null }]);
  const valueToNull = rowsFor(idC, "next_inspection");
  assert.equal(valueToNull.length, 2, "value -> null appends a second row for the same field");
  assert.deepEqual(valueToNull[1], { b: "2026-09-20T10:00:00.000Z", a: null }, "value -> null before/after");

  // -------------------------------------------------------------------
  // Numerically identical but differently typed (1 vs "1") -> zero rows.
  //
  // Not reachable through loadProperties/markSold etc: every tracked numeric
  // column (beds, baths, parking, price_numeric, land_size_sqm) has SQLite
  // NUMERIC/INTEGER/REAL affinity, so a string like "1" written through any
  // real write path is coerced to the integer 1 by SQLite itself before
  // snapshotProperty ever reads it back — before and after would already be
  // the same JS type by construction. recordPropertyChanges is called
  // directly here instead, exactly as its own call sites do, with a
  // hand-built `before` snapshot carrying the OTHER type — this is what
  // actually exercises normalize()'s "1 and \"1\" compare equal" contract.
  // -------------------------------------------------------------------
  loadProperties([{ listingUrl: URL_D, sourceSite: "domain", address: "4 Delta St", beds: 1 }]);
  const idD = idFor(URL_D);
  const realSnapshot = snapshotProperty(idD)!;
  const typeMismatchBefore = { ...realSnapshot, beds: "1" as unknown as number };
  const n = recordPropertyChanges(idD, typeMismatchBefore);
  assert.equal(n, 0, "1 (number) vs \"1\" (string) for the same field produces zero rows");
  assert.equal(changeCount(idD).c, 1, "still just the original synthetic listing row -- nothing appended");

  // -------------------------------------------------------------------
  // sale_status changes, driven through the real write path (markSold /
  // markWithdrawn in status.ts), not by writing scrape_jobs by hand.
  // -------------------------------------------------------------------
  loadProperties([{ listingUrl: URL_E, sourceSite: "domain", address: "5 Epsilon St" }]);
  const idE = idFor(URL_E);
  markSold({ listingUrl: URL_E, price: 900000, date: "2026-09-01" });
  const soldRows = rowsFor(idE, "sale_status");
  assert.equal(soldRows.length, 1, "markSold logs exactly one sale_status row");
  assert.deepEqual(soldRows[0], { b: null, a: "sold" }, "sale_status null -> sold");

  markWithdrawn({ listingUrl: URL_B });
  const withdrawnRows = rowsFor(idB, "sale_status");
  assert.equal(withdrawnRows.length, 1, "markWithdrawn logs exactly one sale_status row");
  assert.deepEqual(withdrawnRows[0], { b: null, a: "withdrawn" }, "sale_status null -> withdrawn");

  // -------------------------------------------------------------------
  // THE HEADLINE REGRESSION (tech-001): two listing_urls that resolve to the
  // SAME property via findTwinByAddress must not have the twin-merge branch
  // log tracked-field diffs -- it is the same listing re-described by another
  // source, not a change. Load the domain listing (creates the row), then the
  // REA listing for the SAME address (attaches via the twin match and
  // introduces fields the domain payload never sent) -- this must add only
  // the ONE synthetic "listing: new" row, not one row per field the REA
  // listing merged in. Then reload BOTH items again, identically: the second
  // round must add zero further rows.
  // -------------------------------------------------------------------
  loadProperties([
    { listingUrl: URL_F_DOMAIN, sourceSite: "domain", address: "6 Zeta St", suburb: "Point Cook", beds: 4, baths: 2 },
  ]);
  const idF = idFor(URL_F_DOMAIN);
  loadProperties([
    {
      listingUrl: URL_F_REA,
      sourceSite: "rea",
      address: "6 Zeta St",
      suburb: "Point Cook",
      agentName: "Jane REA-Agent",
      agencyName: "REA Realty",
      landSizeSqm: 450,
    },
  ]);
  assert.equal(
    changeCount(idF).c,
    1,
    "a twin merge that attaches a second source's listing must not log per-field diffs " +
      "-- only the original synthetic listing row should exist",
  );
  const beforeRound2 = changeCount(idF).c;
  loadProperties([
    { listingUrl: URL_F_DOMAIN, sourceSite: "domain", address: "6 Zeta St", suburb: "Point Cook", beds: 4, baths: 2 },
  ]);
  loadProperties([
    {
      listingUrl: URL_F_REA,
      sourceSite: "rea",
      address: "6 Zeta St",
      suburb: "Point Cook",
      agentName: "Jane REA-Agent",
      agencyName: "REA Realty",
      landSizeSqm: 450,
    },
  ]);
  assert.equal(
    changeCount(idF).c,
    beforeRound2,
    "re-running an IDENTICAL twin-merged payload a second time adds zero property_changes rows",
  );

  // -------------------------------------------------------------------
  // THE HEADLINE REGRESSION, part 2: the two sources DISAGREE on a shared
  // tracked field. Not logging the twin merge is not enough on its own --
  // the merge still WROTE the REA wording over the canonical row, so the
  // next round's byUrl branch found a value it had not written and logged a
  // change back to its own wording, and the twin then wrote the REA wording
  // again. One phantom row per property per sync round, forever. Five
  // identical rounds must leave exactly the one synthetic "listing: new" row.
  // -------------------------------------------------------------------
  const disagreeing = [
    {
      listingUrl: URL_I_DOMAIN,
      sourceSite: "domain",
      address: "9 Iota St",
      suburb: "Point Cook",
      agentName: "Jane Smith",
      priceDisplay: "$850,000",
      beds: 4,
    },
    {
      listingUrl: URL_I_REA,
      sourceSite: "rea",
      address: "9 Iota St",
      suburb: "Point Cook",
      agentName: "Jane E. Smith",
      priceDisplay: "$850,000",
      beds: 4,
    },
  ];
  for (let round = 0; round < 5; round++) loadProperties(disagreeing);
  const idI = idFor(URL_I_DOMAIN);
  assert.equal(
    changeCount(idI).c,
    1,
    "five identical rounds of a dual-listed house whose sources disagree log exactly one row",
  );
  assert.equal(
    (sqlite.prepare("SELECT agent_name a FROM properties WHERE id = ?").get(idI) as { a: string }).a,
    "Jane Smith",
    "the canonical source's wording survives the twin merge",
  );

  // -------------------------------------------------------------------
  // ...and the gap-filling half of the merge still works: a field the
  // canonical row has NO value for is still populated by the secondary
  // source (genuine enrichment), while one it already has is left alone.
  // -------------------------------------------------------------------
  loadProperties([
    {
      listingUrl: URL_J_DOMAIN,
      sourceSite: "domain",
      address: "10 Kappa St",
      suburb: "Point Cook",
      agentName: "Ken Domain",
    },
  ]);
  const idJ = idFor(URL_J_DOMAIN);
  loadProperties([
    {
      listingUrl: URL_J_REA,
      sourceSite: "rea",
      address: "10 Kappa St",
      suburb: "Point Cook",
      agentName: "Ken REA",
      landSizeSqm: 450,
    },
  ]);
  const mergedJ = sqlite
    .prepare("SELECT land_size_sqm l, agent_name a FROM properties WHERE id = ?")
    .get(idJ) as { l: number | null; a: string };
  assert.equal(mergedJ.l, 450, "a NULL field on the canonical row is still filled by the secondary source");
  assert.equal(mergedJ.a, "Ken Domain", "a field the canonical row already has is not overwritten");
  assert.equal(changeCount(idJ).c, 1, "the enriching twin merge still logs nothing of its own");

  // -------------------------------------------------------------------
  // tech-004: a SAME-source match is a RELISTING under a new URL, not a
  // second source re-describing the row. The old URL never returns in the
  // feed, so gap-filling would freeze the row at the withdrawn listing's
  // price/inspection/agent forever while scraped_at kept being refreshed --
  // the row would read as current. Three identical relisting rounds: the
  // relisting's values land, external_id follows so status.ts can still
  // resolve the row, and the price drop is logged exactly once.
  // -------------------------------------------------------------------
  loadProperties([
    {
      listingUrl: URL_K_OLD,
      sourceSite: "domain",
      externalId: "K-OLD",
      address: "12 Mu St",
      suburb: "Point Cook",
      priceDisplay: "$800,000",
      priceNumeric: 800000,
      nextInspection: "2026-09-10T10:00:00.000Z",
      agentName: "Old Agent",
    },
  ]);
  const idK = idFor(URL_K_OLD);
  const relisting = [
    {
      listingUrl: URL_K_NEW,
      sourceSite: "domain",
      externalId: "K-NEW",
      address: "12 Mu St",
      suburb: "Point Cook",
      priceDisplay: "$750,000",
      priceNumeric: 750000,
      nextInspection: "2026-10-04T10:00:00.000Z",
      agentName: "New Agent",
    },
  ];
  for (let round = 0; round < 3; round++) loadProperties(relisting);
  const rowK = sqlite
    .prepare(
      "SELECT price_display pd, next_inspection ni, agent_name an, external_id eid, listing_url lu " +
        "FROM properties WHERE id = ?",
    )
    .get(idK) as { pd: string; ni: string; an: string; eid: string; lu: string };
  assert.equal(rowK.pd, "$750,000", "a same-source relisting updates the price");
  assert.equal(rowK.ni, "2026-10-04T10:00:00.000Z", "a same-source relisting updates the inspection");
  assert.equal(rowK.an, "New Agent", "a same-source relisting updates the agent");
  assert.equal(rowK.eid, "K-NEW", "a same-source relisting updates external_id");
  assert.equal(rowK.lu, URL_K_OLD, "...but never adopts the relisting's listing_url");
  const dropRows = rowsFor(idK, "price_display");
  assert.equal(dropRows.length, 1, "the relisting's price drop is logged once, and only once, over three rounds");
  assert.deepEqual(dropRows[0], { b: "$800,000", a: "$750,000" }, "price drop before/after");
  // The compounding effect: with external_id frozen, status.ts's external-id
  // fallback could no longer resolve the relisting and markSold threw.
  assert.equal(markWithdrawn({ externalId: "K-NEW" }).propertyId, idK, "the relisting resolves by external_id");

  // -------------------------------------------------------------------
  // 2a: gap-fill while live, overwrite once delisted. A cross-source twin
  // merging onto a canonical listing that is already withdrawn may overwrite
  // freely -- the canonical URL is no longer loaded through the by-URL
  // branch, so nothing can flip the values back, and freezing the row would
  // leave stale data the surviving listing could have corrected.
  // -------------------------------------------------------------------
  loadProperties([
    {
      listingUrl: URL_L_DOMAIN,
      sourceSite: "domain",
      address: "13 Nu St",
      suburb: "Point Cook",
      priceDisplay: "$900,000",
      agentName: "Domain Agent",
    },
  ]);
  const idL = idFor(URL_L_DOMAIN);
  markWithdrawn({ listingUrl: URL_L_DOMAIN });
  loadProperties([
    {
      listingUrl: URL_L_REA,
      sourceSite: "rea",
      address: "13 Nu St",
      suburb: "Point Cook",
      priceDisplay: "$820,000",
      agentName: "REA Agent",
    },
  ]);
  const rowL = sqlite
    .prepare("SELECT price_display pd, agent_name an, alt_listing_url alt FROM properties WHERE id = ?")
    .get(idL) as { pd: string; an: string; alt: string | null };
  assert.equal(rowL.pd, "$820,000", "a twin merge onto a WITHDRAWN canonical listing overwrites the price");
  assert.equal(rowL.an, "REA Agent", "...and the agent");
  assert.equal(rowL.alt, URL_L_REA, "...and records the twin's URL as the alt listing");
  assert.deepEqual(
    rowsFor(idL, "price_display")[0],
    { b: "$900,000", a: "$820,000" },
    "an overwriting twin merge logs the change, because nothing will put the old value back",
  );

  // -------------------------------------------------------------------
  // 2b: a property stays active while ANY of its listings is active. Its
  // Domain listing is withdrawn but the REA one is still live, so it must
  // not read as delisted -- and once BOTH are withdrawn, it must.
  // -------------------------------------------------------------------
  loadProperties([
    { listingUrl: URL_M_DOMAIN, sourceSite: "domain", address: "14 Xi St", suburb: "Point Cook" },
  ]);
  const idM = idFor(URL_M_DOMAIN);
  loadProperties([{ listingUrl: URL_M_REA, sourceSite: "rea", address: "14 Xi St", suburb: "Point Cook" }]);
  assert.equal(getProperty(idM)!.altListingUrl, URL_M_REA, "the live cross-source twin records its URL");
  markWithdrawn({ listingUrl: URL_M_DOMAIN });
  assert.equal(
    getSaleStatus(getProperty(idM)!),
    null,
    "withdrawn on Domain but still live on realestate.com.au is NOT delisted",
  );
  const gridLive = listProperties().find((p) => p.id === idM)!;
  assert.equal(gridLive.delisted, false, "the grid agrees -- one derivation, not two");
  assert.equal(gridLive.saleStatus, null, "the grid reports no sale status while a listing is live");

  markWithdrawn({ listingUrl: URL_M_REA });
  assert.equal(
    getSaleStatus(getProperty(idM)!),
    "withdrawn",
    "once EVERY known listing URL is withdrawn the property is delisted",
  );
  const gridGone = listProperties().find((p) => p.id === idM)!;
  assert.equal(gridGone.delisted, true, "the grid agrees once both listings are gone");
  assert.equal(gridGone.saleStatus, "withdrawn", "and reports the canonical listing's status");

  // -------------------------------------------------------------------
  // 2c: sold is terminal on ANY known URL -- a live alt (or live canonical)
  // must never override a sold seen on the other listing.
  // -------------------------------------------------------------------
  loadProperties([
    { listingUrl: URL_N_DOMAIN, sourceSite: "domain", address: "15 Omicron St", suburb: "Point Cook" },
  ]);
  const idN = idFor(URL_N_DOMAIN);
  loadProperties([{ listingUrl: URL_N_REA, sourceSite: "rea", address: "15 Omicron St", suburb: "Point Cook" }]);
  markSold({ listingUrl: URL_N_DOMAIN });
  assert.equal(
    getSaleStatus(getProperty(idN)!),
    "sold",
    "sold on the canonical URL is terminal even while the alt is still live",
  );
  const gridN = listProperties().find((p) => p.id === idN)!;
  assert.equal(gridN.delisted, true, "the grid agrees -- one derivation, not two");
  assert.equal(gridN.saleStatus, "sold", "and reports sold, not active");

  loadProperties([
    { listingUrl: URL_O_DOMAIN, sourceSite: "domain", address: "16 Pi St", suburb: "Point Cook" },
  ]);
  const idO = idFor(URL_O_DOMAIN);
  loadProperties([{ listingUrl: URL_O_REA, sourceSite: "rea", address: "16 Pi St", suburb: "Point Cook" }]);
  markSold({ listingUrl: URL_O_REA });
  assert.equal(
    getSaleStatus(getProperty(idO)!),
    "sold",
    "sold on the alt URL is terminal even while the canonical is still live",
  );
  const gridO = listProperties().find((p) => p.id === idO)!;
  assert.equal(gridO.delisted, true, "the grid agrees for an alt-side sale too");
  assert.equal(gridO.saleStatus, "sold", "and reports sold, not active");

  // -------------------------------------------------------------------
  // tests-001 (a): upsertProperty's plain update (byUrl) branch -- the
  // /api/ingest / npm run scrape call site, which had zero change-log
  // coverage. Two calls with the SAME listingUrl, changing a tracked field
  // on the second: exactly one row for that field.
  // -------------------------------------------------------------------
  upsertProperty({ sourceSite: "domain", listingUrl: URL_H, address: "8 Theta St", beds: 3 });
  const idH = idFor(URL_H);
  assert.equal(changeCount(idH).c, 1, "upsertProperty's fresh insert logs exactly the synthetic listing row");
  upsertProperty({ sourceSite: "domain", listingUrl: URL_H, address: "8 Theta St", beds: 5 });
  const upsertBedsRows = rowsFor(idH, "beds");
  assert.equal(upsertBedsRows.length, 1, "upsertProperty's plain update branch logs exactly one beds row");
  assert.deepEqual(upsertBedsRows[0], { b: "3", a: "5" }, "beds before/after via upsertProperty");
  assert.equal(changeCount(idH).c, 2, "exactly one new row added by the upsertProperty update");

  // -------------------------------------------------------------------
  // tests-001 (b): syncImages -- the other call site with zero coverage, and
  // the only one that can move the "photos" tracked field. A NormalizedImage
  // list that fails to fetch (no network in this suite) wouldn't move the
  // count, so global.fetch is stubbed just for this call to serve a real
  // 1x1 PNG -- syncImages's actual download/hash/probe/insert path still
  // runs, offline.
  // -------------------------------------------------------------------
  loadProperties([{ listingUrl: URL_G, sourceSite: "domain", address: "7 Eta St" }]);
  const idG = idFor(URL_G);
  assert.equal(changeCount(idG).c, 1, "syncImages fixture property starts with just the synthetic listing row");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(TINY_PNG, { status: 200 })) as typeof fetch;
  try {
    const syncResult = await syncImages(idG, [{ sourceUrl: "https://example.com/photo1.jpg", ordinal: 0 }], URL_G);
    assert.equal(syncResult.added, 1, "the stubbed fetch should let syncImages add exactly one image");
  } finally {
    globalThis.fetch = realFetch;
  }
  const photosRows = rowsFor(idG, "photos");
  assert.equal(photosRows.length, 1, "syncImages logs exactly one photos row when the count moves");
  assert.deepEqual(photosRows[0], { b: "0", a: "1" }, "photos count before/after via syncImages");

  // -------------------------------------------------------------------
  // Change logging never throws into the write path: if recordPropertyChanges
  // cannot write (property_changes table itself is gone -- a real SQLite
  // failure, not a mock), the property upsert still succeeds.
  // -------------------------------------------------------------------
  sqlite.exec("DROP TABLE property_changes");
  const upsertResult = loadProperties([{ listingUrl: URL_A, beds: 9 }]);
  assert.equal(upsertResult.updated, 1, "the property upsert still reports success");
  const bedsAfterDrop = sqlite.prepare("SELECT beds FROM properties WHERE id = ?").get(idA) as { beds: number };
  assert.equal(bedsAfterDrop.beds, 9, "the property upsert itself still landed despite change logging failing");

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ changes.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ changes.test FAILED:", e);
  process.exit(1);
});
