/**
 * End-to-end pipeline test that needs NO external network (this sandbox blocks
 * domain.com.au / realestate.com.au). It serves a Domain-shaped fixture from
 * localhost and drives the REAL pipeline: Playwright render -> __NEXT_DATA__
 * parse -> image download -> SQLite persist -> re-scrape idempotency + tag
 * preservation.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

// Isolate DB + images in a temp dir BEFORE importing modules that read env.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-it-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

// 1x1 PNG (valid, probe-able).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function fixtureHtml(port: number, imgCount: number): string {
  const imgs = Array.from(
    { length: imgCount },
    (_, i) => `http://127.0.0.1:${port}/img/${i}.png`,
  );
  const nextData = {
    props: {
      pageProps: {
        componentProps: {
          listingSummary: {
            listingId: "2019999999",
            displayPrice: "$1,250,000",
            bedrooms: 4,
            bathrooms: 2,
            carspaces: 2,
            propertyType: "House",
            displayAddress: "12 Fixture Street, Testville NSW 2000",
            suburb: "Testville",
            state: "NSW",
            postcode: "2000",
            landAreaSqm: 650,
          },
          gallery: { images: imgs.map((url) => ({ url })) },
        },
      },
    },
  };
  return `<!doctype html><html><head><title>12 Fixture Street</title></head>
<body><h1>Listing</h1>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
</body></html>`;
}

async function main() {
  let imgCount = 3;
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/img/")) {
      // Make each image unique (distinct bytes -> distinct hash) so the
      // per-property content-hash dedupe doesn't collapse them. Trailing bytes
      // after IEND don't affect PNG dimension probing.
      const n = parseInt(url.replace(/\D+/g, ""), 10) || 0;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.concat([PNG, Buffer.from([n, n, n, n])]));
    } else {
      const port = (server.address() as import("net").AddressInfo).port;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fixtureHtml(port, imgCount));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("net").AddressInfo).port;
  const listingUrl = `http://127.0.0.1:${port}/listing`;

  // Dynamic imports AFTER env is set.
  const { migrate } = await import("../src/db/migrate");
  const { runScrape } = await import("../src/scrape/runScrape");
  const { closeBrowser } = await import("../src/scrape/browser");
  const { sqlite } = await import("../src/db/client");
  const { collectImageUrls, firstDeep } = await import(
    "../src/scrape/extract"
  );
  const { firstInt, parsePrice } = await import("../src/scrape/adapters/base");

  // Test-only adapter: matches localhost, harvests localhost image URLs.
  const LOCAL_HOST = /127\.0\.0\.1|localhost/;
  const LocalAdapter = {
    site: "domain" as const,
    matches: (h: string) => LOCAL_HOST.test(h),
    normalize(raw: import("../src/scrape/types").RawPageData) {
      const root = raw.nextData ?? {};
      const urls = collectImageUrls(root, LOCAL_HOST);
      return {
        property: {
          sourceSite: "domain" as const,
          listingUrl: raw.url,
          address: String(firstDeep(root, ["displayAddress"]) ?? ""),
          suburb: String(firstDeep(root, ["suburb"]) ?? ""),
          state: String(firstDeep(root, ["state"]) ?? ""),
          postcode: String(firstDeep(root, ["postcode"]) ?? ""),
          priceDisplay: String(firstDeep(root, ["displayPrice"]) ?? ""),
          priceNumeric: parsePrice(firstDeep(root, ["displayPrice"])),
          beds: firstInt(firstDeep(root, ["bedrooms"])),
          baths: firstInt(firstDeep(root, ["bathrooms"])),
          parking: firstInt(firstDeep(root, ["carspaces"])),
          landSizeSqm: firstInt(firstDeep(root, ["landAreaSqm"])),
          propertyType: String(firstDeep(root, ["propertyType"]) ?? ""),
          status: "ok" as const,
        },
        images: urls.map((sourceUrl, ordinal) => ({ sourceUrl, ordinal })),
      };
    },
  };

  try {
    migrate();

    // --- First scrape ---
    const r1 = await runScrape(listingUrl, { adapter: LocalAdapter });
    assert.ok(r1.ok, `first scrape ok: ${r1.error}`);
    assert.equal(r1.images?.added, 3, "3 images added");

    const prop = sqlite
      .prepare("SELECT * FROM properties WHERE listing_url = ?")
      .get(listingUrl) as Record<string, unknown>;
    assert.equal(prop.beds, 4, "beds=4");
    assert.equal(prop.baths, 2, "baths=2");
    assert.equal(prop.parking, 2, "parking=2");
    assert.equal(prop.price_numeric, 1250000, "price parsed to 1250000");
    assert.match(String(prop.address), /Fixture Street/, "address parsed");

    const imgRows = sqlite
      .prepare("SELECT * FROM images WHERE property_id = ? ORDER BY ordinal")
      .all(prop.id) as Record<string, unknown>[];
    assert.equal(imgRows.length, 3, "3 image rows");
    assert.equal(imgRows[0].width, 1, "probed width=1");
    for (const row of imgRows) {
      assert.ok(
        fs.existsSync(path.join(tmp, String(row.local_path))),
        `image file exists: ${row.local_path}`,
      );
    }

    // Tag one image (simulate the Claude tagging step).
    sqlite
      .prepare(
        "INSERT INTO image_tags (image_id, room_type, tagged_at) VALUES (?, 'kitchen', ?)",
      )
      .run(imgRows[0].id, new Date().toISOString());

    // --- Re-scrape (idempotency): same URL, one MORE image added upstream ---
    imgCount = 4;
    const r2 = await runScrape(listingUrl, { adapter: LocalAdapter });
    assert.ok(r2.ok, "second scrape ok");
    assert.equal(r2.images?.kept, 3, "3 existing images kept");
    assert.equal(r2.images?.added, 1, "1 new image added");

    const propCount = (
      sqlite.prepare("SELECT COUNT(*) c FROM properties").get() as { c: number }
    ).c;
    assert.equal(propCount, 1, "still exactly 1 property (upsert, not dup)");

    const imgCountDb = (
      sqlite
        .prepare("SELECT COUNT(*) c FROM images WHERE property_id = ?")
        .get(prop.id) as { c: number }
    ).c;
    assert.equal(imgCountDb, 4, "4 images after re-scrape");

    const tag = sqlite
      .prepare("SELECT * FROM image_tags WHERE image_id = ?")
      .get(imgRows[0].id) as Record<string, unknown> | undefined;
    assert.ok(tag && tag.room_type === "kitchen", "tag survived re-scrape");

    console.log("✓ pipeline.test: all assertions passed");
  } finally {
    // Release every OS handle BEFORE removing the temp dir. On Windows an open
    // browser process or SQLite (WAL: .db/.db-wal/.db-shm) handle makes rmSync
    // fail with EPERM — and a throw here would mask a real assertion failure.
    await closeBrowser();
    sqlite.close();
    server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort: OS may still hold a handle briefly; temp dir is disposable */
    }
  }
}

main().catch((e) => {
  console.error("✗ pipeline.test FAILED:", e);
  process.exit(1);
});
