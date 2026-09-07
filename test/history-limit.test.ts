/**
 * Offline test of src/app/history/page.tsx's `?limit=` guard, plus direct
 * assertions on listPropertyChanges() itself (newest-first order, the
 * watchedOnly filter, and the address/price/thumbnail fields joined onto each
 * row) — rows and one image inserted straight into a temp DB, same idiom as
 * shortlist.test.ts, since the point is the query, not a write path. The page
 * is a plain async server component -- imported and invoked directly rather
 * than driven through a browser, same idiom as changes.test.ts/shortlist.test.ts
 * importing query modules directly. Requires a `React` global because tsx's
 * JSX transform for this repo's `"jsx": "preserve"` tsconfig expects one; the
 * real Next.js build supplies this itself, so this shim exists only for
 * running the component function outside Next.
 *
 * Temp DB, set BEFORE importing app modules — same pattern as batch.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import React from "react";

(globalThis as unknown as { React: typeof React }).React = React;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-history-limit-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function main() {
  const { migrate } = await import("../src/db/migrate");
  migrate();
  const { default: HistoryPage } = await import("../src/app/history/page");

  type PageParams = { watch?: string; limit?: string; offset?: string };
  const render = (params: PageParams) =>
    HistoryPage({ searchParams: Promise.resolve(params) as Promise<PageParams> });
  const call = (limit: string) => render({ limit });

  /**
   * Every `href` in the returned element tree. The page is a plain async
   * server component, so its return value is a tree of React elements that can
   * be walked directly -- no renderer needed, same reason the guard checks
   * above can just await it.
   */
  const hrefs = (node: unknown): string[] => {
    if (Array.isArray(node)) return node.flatMap(hrefs);
    if (!React.isValidElement(node)) return [];
    const props = node.props as { href?: unknown; children?: unknown };
    const own = typeof props.href === "string" ? [props.href] : [];
    return [...own, ...hrefs(props.children)];
  };

  // tech-002: a non-integer or absurdly large `?limit=` used to bind straight
  // into a SQLite LIMIT and throw "datatype mismatch" / overflow, 500ing the
  // page instead of falling back to the default page size.
  for (const bad of ["1.5", "1e21"]) {
    await assert.doesNotReject(
      () => call(bad),
      `?limit=${bad} must not throw -- it should fall back to a sane default instead`,
    );
  }

  // A well-formed limit still renders (no regression in the happy path).
  await assert.doesNotReject(() => call("50"), "a normal integer limit must still work");

  // -------------------------------------------------------------------
  // tests-002: listPropertyChanges() -- newest-first order, the watchedOnly
  // filter, and the address/priceDisplay/thumbPath fields joined onto each
  // row. Rows and one image are inserted directly (same idiom as
  // shortlist.test.ts) rather than via loadProperties -- the point here is
  // the query, not the write path.
  // -------------------------------------------------------------------
  const { sqlite } = await import("../src/db/client");
  const { listPropertyChanges } = await import("../src/db/queries/properties");

  const propNow = new Date().toISOString();
  const insertProp = sqlite.prepare(
    `INSERT INTO properties
       (id, source_site, listing_url, address, price_display, watchlisted, scraped_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertProp.run(
    "propWatched",
    "domain",
    "https://www.domain.com.au/1-watched-st-point-cook-vic-3030-3010000001",
    "1 Watched St",
    "$700,000",
    1,
    propNow,
    propNow,
    propNow,
  );
  insertProp.run(
    "propPlain",
    "domain",
    "https://www.domain.com.au/2-plain-st-point-cook-vic-3030-3010000002",
    "2 Plain St",
    "$800,000",
    null,
    propNow,
    propNow,
    propNow,
  );

  // A real 3:2 (1620x1080) photo, so thumbPath genuinely exercises pickHero
  // rather than trivially returning null for a property with no images.
  sqlite
    .prepare(
      `INSERT INTO images (id, property_id, source_url, local_path, ordinal, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "imgWatched",
      "propWatched",
      "https://example.com/hero.jpg",
      "/images/propWatched/hero.jpg",
      0,
      1620,
      1080,
      propNow,
    );

  const insertChange = sqlite.prepare(
    `INSERT INTO property_changes (id, property_id, field, before, after, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const OLDER = "2026-01-01T00:00:00.000Z";
  const NEWER = "2026-01-02T00:00:00.000Z";
  insertChange.run("chgPlainOld", "propPlain", "beds", "3", "4", OLDER);
  insertChange.run("chgWatchedNew", "propWatched", "price_display", "$650,000", "$700,000", NEWER);

  // Newest-first order -- must fail if .orderBy is flipped to ascending.
  const all = listPropertyChanges({ limit: 10 });
  assert.equal(all.length, 2, "both change rows are returned with no watchedOnly filter");
  assert.equal(all[0].id, "chgWatchedNew", "the newer change (propWatched) must come first");
  assert.equal(all[1].id, "chgPlainOld", "the older change (propPlain) must come second");

  // watchedOnly: true returns only the watchlisted property's change -- must
  // fail if the predicate is inverted (e.g. eq(watchlisted, 0)).
  const watchedRows = listPropertyChanges({ limit: 10, watchedOnly: true });
  assert.equal(watchedRows.length, 1, "watchedOnly:true returns exactly the one watchlisted property's change");
  assert.equal(watchedRows[0].id, "chgWatchedNew", "watchedOnly:true must return the watchlisted property's row");

  // watchedOnly omitted (default false) still includes the watchlisted
  // property's row alongside the unwatched one -- `all` above already proves
  // this, since it was called without watchedOnly and returned both.

  // Joined fields: address, priceDisplay and thumbPath come from the property
  // row, and thumbPath is genuinely non-null via pickHero for a real photo.
  const watchedRow = all.find((r) => r.id === "chgWatchedNew")!;
  assert.equal(watchedRow.address, "1 Watched St", "joined address comes from the property row");
  assert.equal(watchedRow.priceDisplay, "$700,000", "joined priceDisplay comes from the property row");
  assert.equal(watchedRow.thumbPath, "/images/propWatched/hero.jpg", "thumbPath is picked via pickHero, not null");
  const plainRow = all.find((r) => r.id === "chgPlainOld")!;
  assert.equal(plainRow.thumbPath, null, "a property with no images has a null thumbPath");

  // -------------------------------------------------------------------
  // tech-006: "Load more" used to ask for `limit + PAGE_SIZE`, which the 2000
  // cap re-capped to 2000 -- so past 2000 rows the button rendered forever and
  // navigated to an identical page, and the older history was unreachable.
  // 2001 extra rows put the log over the cap; paging must reach past it.
  // -------------------------------------------------------------------
  const OVER_CAP = 2001;
  const bulkBase = Date.UTC(2025, 0, 1);
  sqlite.transaction(() => {
    for (let i = 0; i < OVER_CAP; i++) {
      // Older than the two rows above, and strictly increasing, so the oldest
      // row of all is deterministic: bulk0.
      const at = new Date(bulkBase + i * 1000).toISOString();
      insertChange.run(`bulk${i}`, "propPlain", "beds", String(i), String(i + 1), at);
    }
  })();

  const capped = listPropertyChanges({ limit: 2000 });
  assert.equal(capped.length, 2000, "the cap itself still holds -- one page is never more than 2000 rows");
  const beyond = listPropertyChanges({ limit: 2000, offset: 2000 });
  assert.equal(beyond.length, OVER_CAP + 2 - 2000, "offset reaches the rows the cap cannot");
  assert.ok(
    beyond.some((r) => r.id === "bulk0"),
    "the very oldest row is reachable through offset paging -- it never was through limit alone",
  );

  const firstPage = await render({ limit: "2000" });
  const firstMore = hrefs(firstPage).filter((h) => h.startsWith("/history"));
  assert.equal(firstMore.length, 1, "a full first page offers exactly one paging link");
  assert.ok(
    firstMore[0].includes("offset=2000"),
    `"Load more" must page by offset, not by a bigger limit the cap re-caps -- got ${firstMore[0]}`,
  );

  const lastPage = await render({ limit: "2000", offset: "2000" });
  const lastLinks = hrefs(lastPage).filter((h) => h.startsWith("/history"));
  assert.ok(
    lastLinks.every((h) => !h.includes("offset=4000")),
    "a short final page offers no further page",
  );
  assert.ok(
    lastLinks.some((h) => h.includes("offset=0")),
    "...but does offer the way back, so offset paging is not a one-way trapdoor",
  );

  // The offset guard matches the limit guard: a non-integer, an overflowing
  // value or a negative one must fall back rather than bind into SQLite.
  for (const bad of ["1.5", "1e21", "-5", "abc"]) {
    await assert.doesNotReject(() => render({ offset: bad }), `?offset=${bad} must not throw`);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ history-limit.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ history-limit.test FAILED:", e);
  process.exit(1);
});
