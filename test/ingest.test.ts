/**
 * Offline test of the ingest route: raw payload -> normalize -> upsert property
 * -> log scrape_jobs. No network (a Domain fixture with no CDN images, so
 * syncImages is a no-op). Temp DB, set BEFORE importing app modules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ingest-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { POST } = await import("../src/app/api/ingest/route");
  migrate();

  const raw = {
    url: "https://www.domain.com.au/12-test-st-testville-nsw-2000-2019000111",
    nextData: {
      props: {
        pageProps: {
          componentProps: {
            listingSummary: {
              listingId: "2019000111",
              displayPrice: "$1,250,000",
              bedrooms: 4,
              bathrooms: 2,
              carspaces: 2,
              displayAddress: "12 Test St, Testville NSW 2000",
              suburb: "Testville",
              state: "NSW",
              postcode: "2000",
            },
          },
        },
      },
    },
    jsonLd: [],
    imgUrls: [],
  };

  const res = await POST(
    new Request("http://localhost:3000/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    }),
  );
  const data = (await res.json()) as { ok: boolean; propertyId?: string };
  assert.equal(res.status, 200, "ingest returns 200");
  assert.ok(data.ok, "ingest ok");

  const prop = sqlite
    .prepare("SELECT * FROM properties WHERE listing_url = ?")
    .get(raw.url) as Record<string, unknown>;
  assert.equal(prop.beds, 4, "beds persisted");
  assert.equal(prop.price_numeric, 1250000, "price persisted");
  assert.equal(prop.id, data.propertyId, "returned propertyId matches row");

  const job = sqlite
    .prepare("SELECT * FROM scrape_jobs WHERE url = ?")
    .get(raw.url) as Record<string, unknown>;
  assert.ok(job, "ingest logged a scrape_jobs row");
  assert.equal(job.status, "done", "job done");
  assert.equal(job.property_id, data.propertyId, "job linked to property");

  // Re-ingest the same URL: idempotent (1 property, still 1 job row).
  await POST(
    new Request("http://localhost:3000/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    }),
  );
  const propCount = (
    sqlite.prepare("SELECT COUNT(*) c FROM properties").get() as { c: number }
  ).c;
  const jobCount = (
    sqlite
      .prepare("SELECT COUNT(*) c FROM scrape_jobs WHERE url = ?")
      .get(raw.url) as { c: number }
  ).c;
  assert.equal(propCount, 1, "still 1 property after re-ingest");
  assert.equal(jobCount, 1, "still 1 job row after re-ingest");

  // Unsupported host -> 400.
  const bad = await POST(
    new Request("http://localhost:3000/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/foo" }),
    }),
  );
  assert.equal(bad.status, 400, "unsupported host -> 400");

  // Cross-site twin merge: the same house captured from realestate.com.au has a
  // different listing_url, so it must attach to the existing row (keeping its
  // ratings/notes/metadata) rather than becoming a second one. The REA capture
  // deliberately carries NO postcode — that used to break the match silently.
  const { upsertProperty } = await import("../src/scrape/persist");
  const twinId = upsertProperty({
    sourceSite: "rea",
    listingUrl: "https://www.realestate.com.au/property-house-nsw-testville-1234",
    address: "12 Test Street",
    suburb: "Testville",
    state: "NSW",
  });
  assert.equal(twinId, data.propertyId, "REA capture with no postcode merges into the Domain row");
  assert.equal(
    (sqlite.prepare("SELECT COUNT(*) c FROM properties").get() as { c: number }).c,
    1,
    "twin merge did not create a second row",
  );
  // The canonical listing_url/source_site must survive the merge.
  const merged = sqlite
    .prepare("SELECT listing_url, source_site FROM properties WHERE id = ?")
    .get(twinId) as Record<string, unknown>;
  assert.equal(merged.listing_url, raw.url, "merge keeps the original listing_url");
  assert.equal(merged.source_site, "domain", "merge keeps the original source_site");

  // A genuinely different house on the same street must NOT merge.
  const otherId = upsertProperty({
    sourceSite: "rea",
    listingUrl: "https://www.realestate.com.au/property-house-nsw-testville-9999",
    address: "14 Test Street",
    suburb: "Testville",
    state: "NSW",
  });
  assert.notEqual(otherId, twinId, "a different street number stays a separate property");

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ ingest.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ ingest.test FAILED:", e);
  process.exit(1);
});
