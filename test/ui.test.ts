/**
 * Browser tests for the UI, driven by playwright-core against whatever Chrome
 * is already on the box (see src/scrape/browser.ts) — no test framework, no
 * extra dependencies, same plain-assert style as the other suites.
 *
 * It boots its OWN `next dev` against a COPY of data/app.db (VACUUM INTO, so
 * WAL content comes along) with MEDIA_DIR pointed at a temp dir. Nothing here
 * can touch your real database, images or uploads.
 *
 *   npm run test:ui              # spawns the server itself
 *   BASE_URL=http://localhost:3000 npx tsx test/ui.test.ts   # reuse a server
 *                                # (careful: that one writes to the REAL db)
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { BrowserContext, Page, Request } from "playwright-core";
import { filterKey } from "../src/lib/property-filters";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ui-"));

/** The dev server this run booted. Module-scoped so the teardown in .finally()
 *  reaches it even when main() throws before its own cleanup. */
let server: ChildProcess | undefined;

/**
 * Kill the dev server AND its children. On Windows `spawn("npx.cmd", …, {shell:
 * true})` builds a cmd.exe → npx-cli → next dev → start-server chain, and
 * `kill()` signals only the top of it: every run used to leak a live Next
 * server holding its port, the copied DB and a .next-test handle (which then
 * made the rmSync below fail, and left stale route types behind to break the
 * next `next build`).
 */
function killServer(): void {
  if (!server?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill();
  }
  server = undefined;
}

// ---------------------------------------------------------------- tiny runner
let passed = 0;
const failures: string[] = [];
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => res(port));
    });
  });
}

function get(url: string): Promise<number> {
  return new Promise((res) => {
    const req = http.get(url, (r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    req.on("error", () => res(0));
    req.setTimeout(2000, () => {
      req.destroy();
      res(0);
    });
  });
}

async function waitForServer(base: string, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await get(base)) === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never became ready at ${base}`);
}

// ------------------------------------------------------------- fixture DB/app
/** Snapshot the real DB (WAL-safe) so the tests get real data but can't hurt it. */
function snapshotDb(): string {
  const src = process.env.DB_PATH ?? path.join(ROOT, "data", "app.db");
  const dest = path.join(tmp, "app.db");
  if (!fs.existsSync(src)) throw new Error(`no database at ${src} — run npm run db:migrate`);
  const db = new Database(src, { readonly: true });
  db.exec(`VACUUM INTO '${dest.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  db.close();
  return dest;
}

/** Seed the deterministic state the assertions rely on. Returns ids. */
function seed(dbPath: string) {
  const db = new Database(dbPath);
  const props = db
    .prepare(
      `SELECT id, address FROM properties
        WHERE latitude IS NOT NULL AND price_numeric IS NOT NULL
        ORDER BY id LIMIT 3`,
    )
    .all() as { id: string; address: string | null }[];
  assert.ok(props.length >= 2, "need at least 2 geocoded properties to test with");
  // Clean slate for the fields the UI writes.
  db.exec("DELETE FROM property_ratings");
  // has_eaves reset to unknown so the feature-toggle test's single click
  // (unknown → yes) is deterministic regardless of the real scraped value.
  db.exec("UPDATE properties SET shortlist_tag=NULL, pros=NULL, cons=NULL, has_eaves=NULL");
  db.prepare("UPDATE properties SET shortlist_tag='rejected' WHERE id=?").run(props[0].id);
  // Home grid is Melbourne only — NSW listings live on /sydney.
  const total = (
    db
      .prepare("SELECT count(*) n FROM properties WHERE state IS NULL OR state <> 'NSW'")
      .get() as { n: number }
  ).n;
  db.close();
  return { props, total };
}

// ------------------------------------------------------------------- helpers
const sel = {
  gate: "[data-testid=profile-gate]",
  card: "article",
};

/**
 * Wait for React to hydrate. The header's profile chip is a client component on
 * every page and only gets data-active once its effect has run — filling an
 * input before that point sets the DOM value but never reaches React state.
 */
async function hydrated(page: Page) {
  await page.waitForSelector('header [data-active="true"]');
}

/**
 * Run an action and wait for the write it triggers to actually land.
 * `urlMatch` narrows which PATCH counts — several places fire optimistic
 * fire-and-forget writes, and an unrelated one resolving inside this window
 * used to satisfy the wait before the write under test had landed.
 */
async function saved(
  page: Page,
  action: () => Promise<void>,
  urlMatch = /\/api\/properties\//,
) {
  // .catch keeps a floating rejection from crashing the whole process as an
  // unhandledRejection if `action()` times out before the response arrives.
  const res = page
    .waitForResponse((r) => r.request().method() === "PATCH" && urlMatch.test(r.url()))
    .catch(() => null);
  await action();
  const r = await res;
  assert.ok(r && r.ok(), "PATCH should succeed");
}

async function chooseProfile(page: Page, name = "Gerhard") {
  await page.waitForSelector(sel.gate);
  // Scope to the gate — the header has same-named chips sitting behind it.
  await page.locator(sel.gate).getByRole("button", { name }).click();
  await page.waitForSelector(sel.gate, { state: "detached" });
}

async function main() {
  const base = process.env.BASE_URL ?? `http://localhost:${await freePort()}`;

  if (!process.env.BASE_URL) {
    const dbPath = snapshotDb();
    const port = new URL(base).port;
    server = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["next", "dev", "--port", port],
      {
        cwd: ROOT,
        shell: process.platform === "win32",
        stdio: "ignore",
        env: {
          ...process.env,
          DB_PATH: dbPath,
          MEDIA_DIR: path.join(tmp, "media"),
          NEXT_DIST_DIR: ".next-test",
        },
      },
    );
    console.log(`booting dev server on ${base} (db copy: ${dbPath})`);
    await waitForServer(base);
  }

  const fixture = seed(process.env.BASE_URL ? path.join(ROOT, "data", "app.db") : path.join(tmp, "app.db"));
  const { newContext, closeBrowser } = await import("../src/scrape/browser");
  const ctx: BrowserContext = await newContext();

  // Keep the suite offline and fast: nothing external is under test.
  await ctx.route(
    /fonts\.(googleapis|gstatic)\.com|tile\.openstreetmap\.org|basemaps\.cartocdn\.com|maps\.google\.com|google\.com\/maps/,
    (r) => r.abort(),
  );

  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  console.log("\nprofile gate");
  await t("gate blocks until a profile is chosen, then sticks", async () => {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(sel.gate);
    assert.ok(await page.isVisible(sel.gate), "gate should show on a fresh browser");
    await chooseProfile(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    // Before hydration `ready` is false and the gate is hidden for the wrong
    // reason — so only judge it once the header has come alive.
    await hydrated(page);
    assert.equal(await page.isVisible(sel.gate), false, "gate should stay closed after reload");
  });

  await t("header shows the active profile, and can switch", async () => {
    assert.equal(
      await page.locator("header [data-profile=gerhard]").getAttribute("data-active"),
      "true",
    );
    await page.locator("header [data-profile=johanita]").click();
    await page.waitForSelector('header [data-profile=johanita][data-active="true"]');
    assert.equal(
      await page.locator("header [data-profile=gerhard]").getAttribute("data-active"),
      "false",
      "only one profile is active at a time",
    );
    await page.locator("header [data-profile=gerhard]").click();
    await page.waitForSelector('header [data-profile=gerhard][data-active="true"]');
  });

  console.log("\ngrid");
  await t("renders one card per property and a shown/total counter", async () => {
    const cards = await page.locator(sel.card).count();
    assert.ok(cards > 0, "expected property cards");
    assert.match(await page.locator("h1").first().innerText(), /Tracked properties/);
    assert.match(
      await page.locator("text=shown").first().locator("..").innerText(),
      new RegExp(`/ ${fixture.total}`),
    );
  });

  await t("search narrows the grid and the counter follows", async () => {
    const before = await page.locator(sel.card).count();
    await page.getByPlaceholder("Search address…").fill("zzzz-no-such-street");
    await page.waitForFunction(() => document.querySelectorAll("article").length === 0);
    assert.equal(await page.locator(sel.card).count(), 0);
    await page.getByPlaceholder("Search address…").fill("");
    await page.waitForFunction(
      (n) => document.querySelectorAll("article").length === n,
      before,
    );
  });

  await t("layout switcher renders gallery / compact / list", async () => {
    const grid = page.locator("article").first().locator("..");
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    assert.match(await grid.getAttribute("class") ?? "", /lg:grid-cols-4/);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.waitForSelector("article", { state: "detached" });
    assert.equal(await page.locator(sel.card).count(), 0, "list layout has no cards");
    assert.ok(await page.locator("text=Compare").first().isVisible());
    await page.getByRole("button", { name: "Gallery", exact: true }).click();
    await page.waitForSelector(sel.card);
  });

  await t("shortlist chip filters to the tagged property", async () => {
    await page.getByRole("button", { name: "Rejected" }).click();
    await page.waitForFunction(() => document.querySelectorAll("article").length === 1);
    assert.equal(await page.locator(sel.card).count(), 1);
    await page.getByRole("button", { name: "Rejected" }).click();
    await page.waitForFunction(() => document.querySelectorAll("article").length > 1);
  });

  // The card body has an onClick that opens the listing, guarded so its own
  // controls (and text selection) don't trigger a navigation.
  await t("clicking a card body opens the listing; its buttons don't", async () => {
    const card = page.locator(sel.card).first();
    // saved(): the tile's rating write is fire-and-forget, and leaving it in
    // flight while we navigate lets it resolve inside a later test's
    // waitForResponse window.
    await saved(page, () =>
      card.getByRole("button", { name: "Like", exact: true }).click(),
    );
    assert.equal(
      await card.getByRole("button", { name: "Like", exact: true }).getAttribute("aria-pressed"),
      "true",
      "tile rating should paint immediately",
    );
    assert.match(page.url(), /\/$/, "rating must not navigate");
    // Click a dead spot in the card body (the beds count in the bd/ba/car row,
    // not a control or the address link) and land on the listing.
    const bedCount = card.locator(".border-y b").first();
    await bedCount.click();
    await page.waitForURL(/\/property\//);
    await page.goBack();
    await hydrated(page);

    // Selecting text inside the card must not navigate — the onClick handler
    // bails out when window.getSelection() is non-empty. Double-clicking the
    // h3 address itself would navigate (it's a real <Link> now, by design, so
    // ctrl/middle-click and prefetch keep working), so select some other dead
    // spot in the card body instead — same one used above.
    // Target the price text, not the bd/ba/car row: those are single digits
    // padded by spaces, and a double-click there happily selects just the
    // whitespace — a green test that proves nothing.
    const card2 = page.locator(sel.card).first();
    await card2.locator(".text-forest.font-semibold, .font-semibold.text-forest").first().dblclick();
    const urlBefore = page.url();
    const selection = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    assert.ok(selection.trim().length > 0, "double-click should select text");
    assert.equal(page.url(), urlBefore, "selecting text must not navigate");
  });

  console.log("\ncompare");
  await t("selecting two properties opens a compare table with a ✦ winner", async () => {
    const boxes = page.getByRole("checkbox", { name: "Compare", exact: true });
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    const link = page.getByRole("link", { name: /Compare 2 properties/ });
    await link.waitFor();
    await link.click();
    await page.waitForURL(/\/compare\?ids=/);
    assert.match(await page.locator("h1").innerText(), /Comparing 2 properties/);
    assert.equal(await page.locator("text=✦ Best match").count(), 1, "exactly one winner");
    // Every metric row highlights at most one best cell per row.
    assert.ok((await page.locator("td.bg-\\[\\#F2F6F2\\]").count()) > 0, "expected winning cells");
  });

  console.log("\ndetail rail");
  const detail = `${base}/property/${fixture.props[0].id}`;
  await t("reaction writes through and moves the vibes breakdown", async () => {
    await page.goto(detail, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const total = page.locator("text=✨ VIBES SCORE").locator("..").locator("span").last();
    const before = Number(await total.innerText());
    await page.getByRole("button", { name: /Like/ }).click();
    await page.waitForSelector("text=gerhard: liked it");
    assert.equal(Number(await total.innerText()), before + 25, "like is worth +25");
  });

  // The rail's "Shortlist status" tag and "Your score" slider were removed by
  // request; the deduced-feature toggle is what persists there now.
  await t("feature toggle persists across a reload", async () => {
    // Cycle is yes(1) → no(0) → unknown(null) → yes; drive it to "yes" from
    // whatever the current value is (at most 3 clicks) so it's deterministic.
    const btn = page.locator("[data-feature=hasEaves]").first();
    await btn.waitFor();
    const trace: string[] = [`start=${await btn.getAttribute("data-value")}`];
    for (let i = 0; i < 3; i++) {
      const before = await btn.getAttribute("data-value");
      if (before === "yes") break;
      // Await the property PATCH (not /rating) so the write lands before we
      // later reload — else the reload navigates away mid-request.
      await saved(page, () => btn.click(), /\/api\/properties\/[^/]+$/);
      trace.push(`click${i}: ${before} -> ${await btn.getAttribute("data-value")}`);
    }
    assert.equal(
      await btn.getAttribute("data-value"),
      "yes",
      `optimistic value never reached yes; trace=${JSON.stringify(trace)}`,
    );
    // The real "persists" assertion: the awaited PATCH wrote it to the DB.
    const readEaves = () => {
      const db = new Database(path.join(tmp, "app.db"), { readonly: true });
      const r = db
        .prepare("SELECT has_eaves FROM properties WHERE id=?")
        .get(fixture.props[0].id) as { has_eaves: number } | undefined;
      db.close();
      return r?.has_eaves;
    };
    assert.equal(readEaves(), 1, `has_eaves not persisted to DB; trace=${JSON.stringify(trace)}`);
    // …and a reloaded page reflects it (wait for the rail to render first).
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector("[data-feature=hasEaves]");
    await page.waitForSelector('[data-feature=hasEaves][data-value="yes"]');
  });

  await t("pros and cons round-trip", async () => {
    await page.getByPlaceholder("Add pro + Enter").fill("Big backyard");
    await saved(page, () => page.getByPlaceholder("Add pro + Enter").press("Enter"));
    await page.waitForSelector("text=Big backyard");
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector("text=Big backyard");
    // …and delete it again.
    await page.locator("text=Big backyard").locator("..").getByRole("button", { name: "Remove" }).click();
    await page.waitForSelector("text=Big backyard", { state: "detached" });
  });

  await t("media upload shows a thumbnail and deletes cleanly", async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const file = path.join(tmp, "shot.png");
    fs.writeFileSync(file, png);
    await page.locator("text=My media").locator("../..").locator('input[type="file"]').first()
      .setInputFiles(file);
    const thumb = page.locator('img[src^="/api/media/"]');
    await thumb.waitFor();
    assert.equal(await thumb.count(), 1);
    const dir = path.join(tmp, "media", fixture.props[0].id);
    assert.equal(fs.readdirSync(dir).length, 1, "file lands in MEDIA_DIR, not the real data dir");
    // …and the ✕ removes it from disk too.
    await thumb.hover();
    await page.getByRole("button", { name: "Delete" }).click();
    await thumb.waitFor({ state: "detached" });
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  console.log("\nvibes config");
  await t("changing a weight re-scores the live ranking", async () => {
    await page.goto(`${base}/config`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const rows = page.locator("text=LIVE RANKING").locator("..").locator("a");
    await rows.first().waitFor();
    const before = (await rows.allInnerTexts()).join("|");
    // Station distance is populated for every property, so this weight is
    // guaranteed to move every score (price can be "Contact Agent" → null).
    const station = page
      .locator("text=− per 250 m from the station")
      .locator("..")
      .locator('input[type="number"]');
    await station.fill("20");
    await page.waitForFunction(
      (b) =>
        [...document.querySelectorAll("a[href^='/property/']")]
          .map((a) => (a as HTMLElement).innerText)
          .join("|") !== b,
      before,
      { timeout: 5000 },
    );
    assert.notEqual(
      (await rows.allInnerTexts()).join("|"),
      before,
      "scores should move when a weight changes",
    );
    // …and it survives a reload, because the config lives in localStorage.
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('input[value="20"]');
  });

  console.log("\nmap");
  await t("plots a pin per geocoded property over OSM tiles", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const n = await pins.count();
    assert.ok(n > 0, "expected map pins");
    // "Highlight near" dims non-matching pins rather than removing them.
    await page.getByRole("button", { name: /Playground/ }).click();
    await page.waitForTimeout(200);
    assert.equal(await pins.count(), n, "filter must not drop pins");
    // Untoggling must restore every pin to full opacity — proves the dimming
    // is actually wired to the toggle rather than a static style. (Replaces
    // `assert.ok(dimmed >= 0)`, which was true by construction since `dimmed`
    // is a `.length` and can never be negative — it asserted nothing.)
    await page.getByRole("button", { name: /Playground/ }).click();
    await page.waitForTimeout(200);
    const dimmedAfterUntoggle = await pins.evaluateAll(
      (els) => els.filter((e) => Number((e as HTMLElement).style.opacity) < 1).length,
    );
    assert.equal(dimmedAfterUntoggle, 0, "clearing the highlight restores every pin to full opacity");
  });

  // Regression (verify's requirement-5 gap): pinDiameter() is unit-tested
  // (test/pin-scale.test.ts) but nothing asserted the *rendered* pin actually
  // uses it — deleting the width/height binding in MapView left both `npm
  // test` and `npm run test:ui` green. Reads the visible dot's real size off
  // the page (the button is the larger, floor-24px tap target; the dot inside
  // it carries the scaled width/height) rather than calling pinDiameter()
  // again, so this fails if the binding is removed or constant-ised.
  await t("map pins render 5-50px, scaled by vibe score (requirement 5)", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const dots = page.locator('button[data-testid="map-pin"] > span');
    await dots.first().waitFor();
    const widths = await dots.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    assert.ok(widths.length > 0, "expected map pins");
    assert.ok(
      widths.every((w) => w >= 5 && w <= 50),
      `every pin should render within [5, 50]px, got ${JSON.stringify(widths)}`,
    );
    assert.ok(
      new Set(widths).size >= 2,
      `expected pin widths to vary with vibe score, got ${JSON.stringify(widths)}`,
    );
  });

  // Regression (tests-002): requirement 4 ("/map honours the same filters the
  // home grid uses") had no test that would fail if MapView stopped applying
  // the grid's filters at all — the only /map test above never sets a grid
  // filter, so it can't distinguish "filtered" from "filters bypassed
  // entirely". Writes directly under the key PropertyGrid persists to (see
  // property-filters.ts's filterKey: "vic" region + "gerhard" profile, the
  // profile chosen in the very first test of this suite).
  await t("/map honours the home grid's saved filters (requirement 4)", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const baseline = await pins.count();
    assert.ok(baseline > 0, "expected an unfiltered baseline of map pins");

    // maxPrice below every real fixture price excludes every VIC property
    // without needing to know suburb names or exact fixture prices.
    await page.evaluate(() => {
      localStorage.setItem("filters:gerhard", JSON.stringify({ maxPrice: 1 }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    await page.waitForFunction(
      (n) => document.querySelectorAll('button[data-testid="map-pin"]').length < n,
      baseline,
      { timeout: 5000 },
    );
    const filtered = await pins.count();
    assert.ok(
      filtered < baseline,
      `the grid's saved filter should reduce the map's pins (${filtered} vs baseline ${baseline})`,
    );

    // Clean up so the filter doesn't leak into later tests.
    await page.evaluate(() => localStorage.removeItem("filters:gerhard"));
  });

  // Regression (tests-004): tech-005's fix for the Major "grid filters that
  // exclude every plotted property blank /map to a featureless grey box" has
  // no test — reverting it (routing `view`'s extent back through `pins` alone)
  // must fail this. Reuses requirement-4's mechanism (write a `filters:*`
  // blob, reload, read plain DOM state) and its key, via filterKey — the map
  // reads BOTH regions' saved filters, so both keys need to exclude everything.
  await t("/map still shows a basemap and a notice when filters exclude every property", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const baseline = await pins.count();
    assert.ok(baseline > 0, "expected an unfiltered baseline of map pins");

    const vicKey = filterKey("vic", "gerhard");
    const nswKey = filterKey("nsw", "gerhard");
    await page.evaluate(
      ({ vicKey, nswKey }) => {
        const blob = JSON.stringify({ q: "zzzz-no-such-street" });
        localStorage.setItem(vicKey, blob);
        localStorage.setItem(nswKey, blob);
      },
      { vicKey, nswKey },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForFunction(
      () => document.querySelectorAll('button[data-testid="map-pin"]').length === 0,
      undefined,
      { timeout: 5000 },
    );
    assert.equal(await pins.count(), 0, "the unmatchable filter should exclude every pin");

    // The point of tech-005's fix: the basemap must still render rather than
    // going blank when nothing passes the filter.
    assert.ok(
      (await page.locator('img[src*="tile.openstreetmap.org"]').count()) > 0,
      "expected at least one basemap tile even with every pin filtered out",
    );
    assert.ok(
      await page.getByText(/hidden by your grid filters/).isVisible(),
      "expected the 'hidden by your grid filters' notice",
    );

    // Clean up so the filter doesn't leak into later tests.
    await page.evaluate(
      ({ vicKey, nswKey }) => {
        localStorage.removeItem(vicKey);
        localStorage.removeItem(nswKey);
      },
      { vicKey, nswKey },
    );
  });

  console.log("\nrooms");
  await t("rooms page loads and its chips navigate", async () => {
    await page.goto(`${base}/rooms`, { waitUntil: "domcontentloaded" });
    assert.match(await page.locator("h1").innerText(), /Room-by-room/);
    const chip = page.locator('a[href^="/rooms?room="]').first();
    if ((await chip.count()) > 0) {
      await chip.click();
      await page.waitForURL(/\/rooms\?room=/);
      assert.match(await page.locator("h2").first().innerText(), /photos across properties/);
    }
  });

  console.log("\nresponsive");
  const MOBILE = { width: 390, height: 844 }; // iPhone 14-ish
  const DESKTOP = { width: 1440, height: 900 };

  // A property that actually has photos, for the detail + lightbox checks.
  const dbRO = new Database(path.join(tmp, "app.db"), { readonly: true });
  const photoProp = dbRO
    .prepare(
      "SELECT property_id id, COUNT(*) n FROM images GROUP BY property_id HAVING n > 1 ORDER BY n DESC LIMIT 1",
    )
    .get() as { id: string; n: number } | undefined;
  dbRO.close();
  const detailId = photoProp?.id ?? fixture.props[0].id;

  /** Fail if the PAGE scrolls horizontally, naming the elements that overflow. */
  async function noHScroll(label: string, url: string) {
    await page.setViewportSize(MOBILE);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const de = document.documentElement;
      const vw = de.clientWidth;
      const bad: { tag: string; cls: string; right: number; ox: string }[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.right > vw + 1) {
          const st = getComputedStyle(el);
          bad.push({
            tag: el.tagName.toLowerCase(),
            cls: String((el as HTMLElement).className).slice(0, 50),
            right: Math.round(r.right),
            ox: st.overflowX,
          });
        }
      }
      return { vw, sw: de.scrollWidth, bad: bad.slice(0, 6) };
    });
    assert.ok(
      info.sw <= info.vw + 1,
      `${label}: page scrolls sideways (scrollWidth ${info.sw} > viewport ${info.vw}). ` +
        `Offenders: ${JSON.stringify(info.bad)}`,
    );
  }

  for (const [label, url] of [
    ["home", base],
    ["detail", `${base}/property/${detailId}`],
    ["compare", `${base}/compare?ids=${fixture.props[0].id},${fixture.props[1].id}`],
    ["rooms", `${base}/rooms`],
    ["map", `${base}/map`],
    ["config", `${base}/config`],
  ] as const) {
    await t(`no horizontal scroll on mobile — ${label}`, () => noHScroll(label, url));
  }

  await t("filter toolbar rows are aligned into one column on mobile", async () => {
    await page.setViewportSize(MOBILE);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const info = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("select"))
        .map((s) => s.closest("label"))
        .filter(Boolean) as HTMLElement[];
      const rects = labels.map((l) => l.getBoundingClientRect());
      const widths = rects.map((r) => Math.round(r.width));
      const lefts = rects.map((r) => Math.round(r.left));
      // Inline the max-min (a named inner fn trips tsx/esbuild's __name in evaluate).
      const widthSpan = widths.length ? Math.max(...widths) - Math.min(...widths) : 0;
      const leftSpan = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 0;
      const dividers = Array.from(document.querySelectorAll("div.w-px"));
      const visibleDividers = dividers.filter((d) => getComputedStyle(d).display !== "none").length;
      return { widths, lefts, widthSpan, leftSpan, visibleDividers };
    });
    assert.ok(info.widths.length >= 5, `expected filter selects, saw ${info.widths.length}`);
    // Aligned = same width and same left edge (one clean column), not ragged.
    assert.ok(info.widthSpan <= 2, `filter rows have ragged widths: ${JSON.stringify(info.widths)}`);
    assert.ok(info.leftSpan <= 2, `filter rows are not left-aligned: ${JSON.stringify(info.lefts)}`);
    assert.equal(info.visibleDividers, 0, "vertical dividers must be hidden on mobile");
  });

  // A short phrase forced to wrap into 3+ lines means a column too narrow for it
  // (e.g. distance text crushed next to buttons). Flags cramped/squashed layout
  // that a horizontal-scroll check can't see.
  //
  // CAVEAT, measured 2026-08-09: this runs with fonts.googleapis.com aborted (see
  // ctx.route below), so headings render in the fallback serif, which is wider
  // than Instrument Serif. On the home grid that is the whole difference between
  // pass and fail — with the real font loaded 0 of 337 addresses wrap to 3 lines;
  // with it blocked, 2 do ("224 Saltwater Promenade…", "105 Williams Landing
  // Boulevard…"). Before changing any card CSS to chase a failure here, check
  // whether it reproduces with the font actually loaded.
  async function squashOffenders(url: string) {
    await page.setViewportSize(MOBILE);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForTimeout(200);
    return page.evaluate(() => {
      const out: { text: string; lines: number; width: number }[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        // Only leaf-ish elements whose OWN text (not a child's) is what wraps.
        const textNodes = Array.from(el.childNodes).filter(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim(),
        );
        if (!textNodes.length) continue;
        const direct = textNodes.map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
        const words = direct.split(" ").length;
        // Short phrases only — real prose legitimately wraps to many lines.
        if (direct.length > 55 || words > 8) continue;
        // Count ACTUAL visual line-boxes of the element's OWN text via Range rects
        // over each direct text node (NOT child elements), grouped by top. This
        // ignores box height from flex-centering / tall cells / iframes and the
        // line count of nested children — only this element's text wrapping counts.
        const tops = new Set<number>();
        for (const tn of textNodes) {
          const rng = document.createRange();
          rng.selectNodeContents(tn);
          for (const rc of Array.from(rng.getClientRects())) {
            if (rc.width > 0 && rc.height > 0) tops.add(Math.round(rc.top));
          }
        }
        const lines = tops.size;
        const width = Math.round((el as HTMLElement).getBoundingClientRect().width);
        // Cramped = a short phrase in a grid CARD squeezed into a sub-column far
        // narrower than the card, i.e. crammed next to fixed-width controls while
        // space sits unused (the "text smooshed next to buttons" pathology). Scoped
        // to <article> cards; label/value rows and tables use narrow columns by
        // design, so those are only caught by the severe ≥3-line rule below.
        const card = el.closest("article") as HTMLElement | null;
        const cardW = card ? card.getBoundingClientRect().width : 0;
        const cramped = lines >= 2 && cardW > 0 && width < 0.45 * cardW;
        // Flag severe wrapping anywhere (≥3 lines) OR a cramped card sub-column.
        if (lines >= 3 || cramped) out.push({ text: direct.slice(0, 40), lines, width });
      }
      return out.slice(0, 8);
    });
  }

  for (const [label, url] of [
    ["home cards", base],
    ["detail", `${base}/property/${detailId}`],
    ["compare", `${base}/compare?ids=${fixture.props[0].id},${fixture.props[1].id}`],
  ] as const) {
    await t(`no squashed/over-wrapped text on mobile — ${label}`, async () => {
      const bad = await squashOffenders(url);
      assert.equal(bad.length, 0, `squashed text (short phrase wrapping 3+ lines): ${JSON.stringify(bad)}`);
    });
  }

  await t("lightbox fits the desktop viewport (not a too-tall modal)", async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${base}/property/${detailId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const opener = page.locator('button[title="Open"]').first();
    await opener.waitFor();
    await opener.click();
    const modal = page.locator("div.fixed.inset-0.z-\\[90\\]");
    await modal.waitFor();
    const m = await modal.boundingBox();
    assert.ok(m, "modal should render");
    assert.ok(
      m!.height <= DESKTOP.height + 1,
      `modal is ${m!.height}px tall, taller than the ${DESKTOP.height}px viewport`,
    );
    // The photo must sit fully on-screen (object-contain + max-h-full).
    const ib = await modal.locator("img").first().boundingBox();
    assert.ok(
      ib && ib.y >= -1 && ib.y + ib.height <= DESKTOP.height + 1,
      `photo overflows the viewport vertically: ${JSON.stringify(ib)}`,
    );
    // Filmstrip, when present, stays on-screen at the bottom.
    const strip = modal.locator("div.overflow-x-auto").first();
    if ((await strip.count()) > 0) {
      const sb = await strip.boundingBox();
      assert.ok(
        sb && sb.y + sb.height <= DESKTOP.height + 1,
        `filmstrip pushed off-screen: ${JSON.stringify(sb)}`,
      );
    }
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    await page.setViewportSize(DESKTOP);
  });

  // Regression: a closed native <select> consumes arrow keys itself (changes
  // the selected option and fires `change`) before Lightbox's own window
  // keydown handler ever sees them. TagSelect's onChange PATCHes the room tag
  // immediately, so browsing photos with the arrow keys while focus happens to
  // sit in the room dropdown silently re-tags photos. Assert on the actual
  // write (the PATCH request), not just the DOM value, since that's the thing
  // that can't be undone by looking at the screen.
  await t("arrow keys in the lightbox never mutate the focused room tag", async () => {
    await page.setViewportSize(DESKTOP);
    const tagPatches: string[] = [];
    const onRequest = (req: Request) => {
      if (req.method() === "PATCH" && /\/api\/images\/[^/]+\/tag/.test(req.url())) {
        tagPatches.push(req.url());
      }
    };
    page.on("request", onRequest);
    await page.goto(`${base}/property/${detailId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const opener = page.locator('button[title="Open"]').first();
    await opener.waitFor();
    await opener.click();
    const modal = page.locator("div.fixed.inset-0.z-\\[90\\]");
    await modal.waitFor();
    const counter = modal.locator("span.text-sm.text-neutral-300").first();
    const select = modal.locator("select");
    await select.waitFor();

    const counterBefore = await counter.innerText();
    assert.match(counterBefore, /^\d+ \/ [2-9]\d*/, "fixture needs a property with 2+ visible photos");
    const valueBefore = await select.inputValue();
    assert.notEqual(valueBefore, "", "fixture's first photo should already carry a room tag");

    await select.focus();
    // On Chrome/Windows a closed <select> responds to all four arrows (Up/Down
    // step the option list; Left/Right do too). Up/Down aren't bound to photo
    // navigation at all, so any of these four still mutating the tag proves
    // the corruption; ArrowUp/ArrowDown alone (net zero on the photo index
    // either way) isolate that from the "does Left/Right still browse?" check
    // below, which a Left-then-Right round trip would otherwise mask.
    for (const key of ["ArrowDown", "ArrowUp", "ArrowDown", "ArrowUp"]) {
      await page.keyboard.press(key);
    }
    // Give a native `change` → fetch() a moment to land if it was going to.
    await page.waitForTimeout(300);
    assert.deepEqual(tagPatches, [], `Up/Down wrote the room tag: ${JSON.stringify(tagPatches)}`);
    assert.equal(await select.inputValue(), valueBefore, "room select value must not change from arrow keys");
    assert.equal(await counter.innerText(), counterBefore, "Up/Down should not move the photo either");

    // Left/Right must still browse — the fix isn't allowed to swallow them —
    // and must still leave the tag alone.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    assert.deepEqual(tagPatches, [], `ArrowRight wrote the room tag: ${JSON.stringify(tagPatches)}`);
    assert.equal(await select.inputValue(), valueBefore, "room select value must not change from ArrowRight");
    const counterAfter = await counter.innerText();
    assert.notEqual(counterAfter, counterBefore, "ArrowRight should still navigate to the next photo");

    page.off("request", onRequest);
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
  });

  // Regression (tech-001): End, PageUp and PageDown step a closed native
  // <select> exactly like the arrows do, and were not covered by the guard
  // above — so the same silent re-tag stayed reachable from those three keys.
  await t("End/PageUp/PageDown in the lightbox never mutate the focused room tag", async () => {
    await page.setViewportSize(DESKTOP);
    const tagPatches: string[] = [];
    const onRequest = (req: Request) => {
      if (req.method() === "PATCH" && /\/api\/images\/[^/]+\/tag/.test(req.url())) {
        tagPatches.push(req.url());
      }
    };
    page.on("request", onRequest);
    await page.goto(`${base}/property/${detailId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const opener = page.locator('button[title="Open"]').first();
    await opener.waitFor();
    await opener.click();
    const modal = page.locator("div.fixed.inset-0.z-\\[90\\]");
    await modal.waitFor();
    const select = modal.locator("select");
    await select.waitFor();
    const valueBefore = await select.inputValue();
    assert.notEqual(valueBefore, "", "fixture's first photo should already carry a room tag");

    await select.focus();
    for (const key of ["End", "PageDown", "PageUp", "Home"]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(300);
    assert.deepEqual(
      tagPatches,
      [],
      `End/PageDown/PageUp/Home wrote the room tag: ${JSON.stringify(tagPatches)}`,
    );
    assert.equal(
      await select.inputValue(),
      valueBefore,
      "room select value must not change from End/PageDown/PageUp/Home",
    );

    page.off("request", onRequest);
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
  });

  await t("choosing a room from the open dropdown still saves (mouse/select)", async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`${base}/property/${detailId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const opener = page.locator('button[title="Open"]').first();
    await opener.waitFor();
    await opener.click();
    const modal = page.locator("div.fixed.inset-0.z-\\[90\\]");
    await modal.waitFor();
    const select = modal.locator("select");
    await select.waitFor();
    const before = await select.inputValue();
    const next = before === "kitchen" ? "bathroom" : "kitchen";
    await saved(page, async () => { await select.selectOption(next); }, /\/api\/images\/[^/]+\/tag/);
    assert.equal(await select.inputValue(), next, "choosing an option should still update the select");
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
  });

  console.log("\nproperty.com.au enrichment");
  // Day-one state: both new columns NULL for every row (no backfill yet) — the
  // detail page must show no "Year built" row and no property.com.au link, and
  // no empty placeholder/stray label. This is the more important of the two
  // cases, since it's what every row looks like on day one in prod.
  await t("detail page shows no year-built row or property.com.au link when both are NULL", async () => {
    const dbRW = new Database(path.join(tmp, "app.db"));
    dbRW.prepare("UPDATE properties SET property_com_au_url = NULL, year_built = NULL WHERE id = ?").run(detailId);
    dbRW.close();
    await page.goto(`${base}/property/${detailId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    // "Listing details" is the card heading, not inside the <dl> — scope on
    // the whole card, matching the page's own structure.
    const card = page.locator("div.card", { hasText: "Listing details" }).first();
    await card.locator("dt").first().waitFor();
    assert.equal(
      await card.locator("dt", { hasText: "Year built" }).count(),
      0,
      "no Year built row when yearBuilt is NULL",
    );
    assert.equal(
      await card.locator("dt", { hasText: "property.com.au" }).count(),
      0,
      "no property.com.au row when propertyComAuUrl is NULL",
    );
    assert.equal(
      await page.locator("a", { hasText: "View listing" }).count(),
      0,
      "no dangling 'View listing' link when there's nothing to link to",
    );
  });

  await t("detail page renders the year built and property.com.au link when present", async () => {
    const url = "https://www.property.com.au/vic/point-cook-3030/villiers-dr/20-pid-9472083/";
    const dbRW = new Database(path.join(tmp, "app.db"));
    dbRW.prepare("UPDATE properties SET property_com_au_url = ?, year_built = ? WHERE id = ?").run(url, 2008, detailId);
    dbRW.close();
    await page.goto(`${base}/property/${detailId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const card = page.locator("div.card", { hasText: "Listing details" }).first();
    await card.locator("dt", { hasText: "Year built" }).waitFor();
    assert.match(
      await card.locator("dd").filter({ hasText: /^2008$/ }).innerText(),
      /2008/,
      "year built value renders",
    );
    const link = page.locator("a", { hasText: "View listing" });
    await link.waitFor();
    assert.equal(await link.getAttribute("href"), url, "property.com.au link points at the stored URL");
    assert.equal(await link.getAttribute("target"), "_blank");
    // Reset so this doesn't leak into any test that runs after this one.
    const dbReset = new Database(path.join(tmp, "app.db"));
    dbReset.prepare("UPDATE properties SET property_com_au_url = NULL, year_built = NULL WHERE id = ?").run(detailId);
    dbReset.close();
  });

  console.log("\nregressions");
  await t("no uncaught page errors across the whole run", async () => {
    assert.deepEqual(consoleErrors, []);
  });

  await ctx.close();
  await closeBrowser();
  killServer();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    // Belt and braces: main() kills the server on its happy path, but a throw
    // anywhere above that would otherwise strand it.
    killServer();
    // Windows keeps SQLite/Next handles open a moment after the processes die;
    // a leftover temp dir isn't worth failing the run over.
    for (const dir of [tmp, path.join(ROOT, ".next-test")]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* ignore */
      }
    }
  });
