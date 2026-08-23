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
import { formatPrice } from "../src/lib/format";

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

/**
 * The set of addresses (from the same DB copy the server reads) belonging to
 * one side of the VIC/NSW split — used to check map-pin IDENTITY rather than
 * just a pin count, so an inverted region filter can't pass by coincidence of
 * totals. Two static, non-concatenated queries rather than one templated by
 * a boolean, per the parameterised-query rule.
 */
function addressesByRegion(nsw: boolean): Set<string> {
  const db = new Database(path.join(tmp, "app.db"), { readonly: true });
  const rows = (
    nsw
      ? db.prepare("SELECT address FROM properties WHERE latitude IS NOT NULL AND state = 'NSW'").all()
      : db
          .prepare("SELECT address FROM properties WHERE latitude IS NOT NULL AND (state IS NULL OR state <> 'NSW')")
          .all()
  ) as { address: string | null }[];
  db.close();
  return new Set(rows.map((r) => r.address).filter((a): a is string => !!a));
}

/**
 * Fixtures for the map pin popup. `withImage` is a VIC geocoded property with
 * at least one non-excluded image — pickHero's own `imgs[0] ?? null` floor
 * (src/db/queries/properties.ts) guarantees a non-null thumbPath whenever such
 * a row exists, regardless of which heuristic actually picks the hero.
 * `withoutImage` is a VIC geocoded property with NO image rows at all, so
 * thumbPath is null trivially (pickHero on an empty array is null by
 * construction) — found at runtime rather than hardcoded, and `null` if the
 * fixture DB has none (checked, not assumed: see the caller).
 */
function mapPopupFixtures(): {
  withImage: { id: string; address: string; priceDisplay: string | null; priceNumeric: number | null };
  withoutImage: { id: string; address: string } | null;
} {
  const db = new Database(path.join(tmp, "app.db"), { readonly: true });
  const withImage = db
    .prepare(
      `SELECT DISTINCT p.id, p.address, p.price_display priceDisplay, p.price_numeric priceNumeric
         FROM properties p
         JOIN images i ON i.property_id = p.id
         LEFT JOIN image_tags t ON t.image_id = i.id
        WHERE p.latitude IS NOT NULL AND (p.state IS NULL OR p.state <> 'NSW')
          AND p.address IS NOT NULL
          AND (t.room_type IS NULL OR t.room_type <> 'exclude')
        ORDER BY p.id LIMIT 1`,
    )
    .get() as { id: string; address: string; priceDisplay: string | null; priceNumeric: number | null } | undefined;
  assert.ok(withImage, "need a VIC geocoded property with a non-excluded image to test the popup's hero image");

  const withoutImage = db
    .prepare(
      `SELECT p.id, p.address
         FROM properties p
        WHERE p.latitude IS NOT NULL AND (p.state IS NULL OR p.state <> 'NSW')
          AND p.address IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM images i WHERE i.property_id = p.id)
        ORDER BY p.id LIMIT 1`,
    )
    .get() as { id: string; address: string } | undefined;
  db.close();
  return { withImage: withImage!, withoutImage: withoutImage ?? null };
}

/**
 * Mirrors isPropertyPhoto/isVisibleImage from src/db/queries/properties.ts —
 * duplicated rather than imported, since that module opens a real DB
 * connection as an import side effect and this suite must never touch
 * anything but the throwaway tmp copy.
 */
function isVisibleImageLike(i: {
  width: number | null;
  height: number | null;
  roomType: string | null;
  notes: string | null;
}): boolean {
  if (i.roomType === "exclude") return false;
  if (i.notes === "floorplan" || i.notes === "hero") return true;
  const a = i.width && i.height ? i.width / i.height : null;
  if (a == null || !i.width || !i.height) return true;
  if (Math.max(i.width, i.height) < 500) return false;
  if (a >= 2.2 || a <= 0.45) return false;
  return !(a > 0.95 && a < 1.05);
}

/**
 * A property with two ADJACENT visible photos, in the same order Lightbox
 * browses them, tagged with different rooms — the fixture for the
 * TagSelect-remount regression: without `key={img.id}` on TagSelect
 * (Lightbox.tsx), advancing to the next photo leaves the room dropdown
 * showing the room of the one before it.
 */
function adjacentRoomChangePhoto(): { propertyId: string; index: number; roomA: string; roomB: string } {
  const db = new Database(path.join(tmp, "app.db"), { readonly: true });
  const propertyIds = (
    db.prepare("SELECT DISTINCT property_id id FROM images ORDER BY property_id").all() as { id: string }[]
  ).map((r) => r.id);
  for (const propertyId of propertyIds) {
    const rows = db
      .prepare(
        `SELECT i.width, i.height, t.room_type roomType, t.notes notes
           FROM images i LEFT JOIN image_tags t ON t.image_id = i.id
          WHERE i.property_id = ? ORDER BY i.ordinal`,
      )
      .all(propertyId) as {
      width: number | null;
      height: number | null;
      roomType: string | null;
      notes: string | null;
    }[];
    const visible = rows.filter(isVisibleImageLike);
    for (let index = 0; index < visible.length - 1; index++) {
      const a = visible[index];
      const b = visible[index + 1];
      if (a.roomType && b.roomType && a.roomType !== b.roomType) {
        db.close();
        return { propertyId, index, roomA: a.roomType, roomB: b.roomType };
      }
    }
  }
  db.close();
  throw new Error("fixture needs a property with two adjacent visible photos tagged with different rooms");
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

  // Regression (corr-001): autoView's no-coordinates fallback centre used to
  // be a single hardcoded Melbourne CBD pair, reachable from /sydney/map (a
  // NSW-only route) whenever no NSW property has coordinates — the empty
  // basemap would centre on Melbourne under its own "no coordinates" notice.
  // No browser needed: this checks the region lookup itself, directly.
  await t("the no-coordinates fallback centre differs by region (corr-001)", async () => {
    const { REGION_FALLBACK_CENTRE } = await import("../src/components/MapView");
    assert.notDeepEqual(
      REGION_FALLBACK_CENTRE.vic,
      REGION_FALLBACK_CENTRE.nsw,
      "vic and nsw should fall back to different CBD centres",
    );
  });

  // A pin's only DOM-visible identity is its `title` — see MapView's
  // `title={`${p.address} — ${formatPrice(...)} · vibe ${score}`}` — so pull
  // the address back off it (split on the em dash) rather than trusting a
  // pin count, which would still pass if the region filter were inverted and
  // the totals happened to match.
  function pinAddresses(titles: string[]): string[] {
    return titles.map((title) => title.split(" — ")[0]);
  }

  /**
   * The nth-locator index of the pin for a given address, read off the same
   * `title` attribute as pinAddresses above rather than a CSS attribute
   * selector — avoids escaping whatever punctuation a real address contains.
   */
  async function pinIndex(address: string): Promise<number> {
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const titles = await pins.evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
    const idx = pinAddresses(titles).findIndex((a) => a === address);
    assert.ok(idx >= 0, `expected a map pin for "${address}"`);
    return idx;
  }

  /**
   * Click a specific pin by its locator index via the DOM node's own
   * `.click()` rather than Playwright's mouse-driven `locator.click()`.
   * Point Cook alone plots hundreds of pins and several share (or nearly
   * share) a screen position at the map's default view — Playwright's real
   * actionability check then times out with "subtree intercepts pointer
   * events" because whichever pin paints on top physically receives the
   * click. These popup tests aren't exercising the drag/jitter pointer-capture
   * path (see [[drag_vs_click_suppression]]) — draggedRef is only ever set by
   * a real pointerdown/pointermove sequence, neither of which this fires — so
   * dispatching straight at the intended node is equivalent for what's being
   * asserted here and immune to whatever happens to be stacked on top of it.
   */
  async function clickPin(index: number) {
    await page
      .locator('button[data-testid="map-pin"]')
      .nth(index)
      .evaluate((el) => (el as HTMLButtonElement).click());
  }

  await t("/map renders VIC pins only — no NSW property appears (requirement 1)", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const titles = await pins.evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
    assert.ok(titles.length > 0, "expected map pins");

    const nswAddresses = addressesByRegion(true);
    const vicAddresses = addressesByRegion(false);
    for (const address of pinAddresses(titles)) {
      assert.ok(!nswAddresses.has(address), `pin "${address}" is a NSW property and must not appear on /map`);
      assert.ok(vicAddresses.has(address), `pin "${address}" is not a known VIC property with coordinates`);
    }
  });

  await t("/sydney/map renders NSW pins only (requirement 2)", async () => {
    const nswAddresses = addressesByRegion(true);
    const vicAddresses = addressesByRegion(false);

    await page.goto(`${base}/sydney/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const pins = page.locator('button[data-testid="map-pin"]');

    if (nswAddresses.size === 0) {
      // Nothing to assert region-identity against — say so plainly rather
      // than faking a NSW fixture. Still confirms the page renders and plots
      // nothing, since there's nothing to plot.
      console.log("  (no geocoded NSW property in the fixture DB — asserting zero pins only)");
      await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
      assert.equal(await pins.count(), 0, "no geocoded NSW property means no pins should render");
      return;
    }

    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    await pins.first().waitFor();
    const titles = await pins.evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
    assert.ok(titles.length > 0, "expected /sydney/map to render NSW pins");
    for (const address of pinAddresses(titles)) {
      assert.ok(!vicAddresses.has(address), `pin "${address}" is a VIC property and must not appear on /sydney/map`);
      assert.ok(nswAddresses.has(address), `pin "${address}" is not a known NSW property with coordinates`);
    }
  });

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
  // blob, reload, read plain DOM state) and its key, via filterKey.
  //
  // CHANGED for the region split: this test used to write BOTH the vic and
  // nsw filter keys, because /map's MapView read both regions' saved filters
  // at once and merged their pins. That dual-region reading is exactly what
  // this run deleted — /map now reads only the "vic" key (see MapView's
  // single `region` prop) — so writing an nsw key here no longer does
  // anything and would just be dead code asserting nothing about the current
  // behaviour. Only the vic key is written now.
  await t("/map still shows a basemap and a notice when filters exclude every property", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const baseline = await pins.count();
    assert.ok(baseline > 0, "expected an unfiltered baseline of map pins");

    const vicKey = filterKey("vic", "gerhard");
    await page.evaluate((vicKey) => {
      localStorage.setItem(vicKey, JSON.stringify({ q: "zzzz-no-such-street" }));
    }, vicKey);
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
    await page.evaluate((vicKey) => localStorage.removeItem(vicKey), vicKey);
  });

  // Pan/zoom interaction tests below. None of this logic had ever run in a
  // real browser before this run — the drag-slop, pointer-capture click
  // suppression and wheel accumulator were reasoned from spec, not observed.
  // `div.touch-none` is MapView's map box: the only element in the app with
  // that class, so it's a stable-enough selector without a dedicated testid.
  const mapBox = () => page.locator("div.touch-none");

  /** The `z` of the first visible OSM tile, parsed off its `src`. */
  async function tileZoom(): Promise<number> {
    const src = await page.locator('img[src*="tile.openstreetmap.org"]').first().getAttribute("src");
    const m = src?.match(/tile\.openstreetmap\.org\/(\d+)\//);
    assert.ok(m, `expected a tile src with a /{z}/ segment, got ${src}`);
    return Number(m![1]);
  }

  await t("dragging the map pans it — direction and distance match the drag", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();

    const before = await pins.first().boundingBox();
    assert.ok(before, "expected the first pin to have a bounding box");
    const box = await mapBox().boundingBox();
    assert.ok(box, "expected the map box to have a bounding box");

    // Start well clear of the box edges so the drag stays inside it; the
    // exact starting point doesn't matter (dragging that starts on a pin is
    // covered separately below) — only the (dx, dy) applied matters here.
    const startX = box!.x + 40;
    const startY = box!.y + 40;
    const dx = 90;
    const dy = 55;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await pins.first().boundingBox();
    assert.ok(after, "expected the first pin to still have a bounding box after the drag");
    // Screen position is `pinScreen = projected - origin`, and a drag of
    // (dx, dy) sets `origin -= (dx, dy)`, so the pin should move by exactly
    // (dx, dy) — a few px of tolerance for the browser's own subpixel
    // rounding, not for any uncertainty in the direction or magnitude.
    assert.ok(
      Math.abs(after!.x - before!.x - dx) <= 3,
      `dragging right by ${dx}px should move the pin right by ~${dx}px, moved ${after!.x - before!.x}`,
    );
    assert.ok(
      Math.abs(after!.y - before!.y - dy) <= 3,
      `dragging down by ${dy}px should move the pin down by ~${dy}px, moved ${after!.y - before!.y}`,
    );
  });

  // The most important test in this handoff: pointer capture (set on
  // pointerdown so drag-move/up keep targeting the map box regardless of
  // what's under the cursor) must not also let a real drag's terminal click
  // reach a pin's onClick and navigate. Two shapes, per the brief: release
  // over a pin having started elsewhere, and having started ON a pin.
  await t("a drag that ends over a pin does not navigate to it", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const box = await mapBox().boundingBox();
    const pin = await pins.first().boundingBox();
    assert.ok(box && pin, "expected both the map box and a pin to have bounding boxes");

    const targetX = pin!.x + pin!.width / 2;
    const targetY = pin!.y + pin!.height / 2;
    // Start comfortably clear of the pin (well past DRAG_SLOP=6) but still
    // inside the map box.
    const startX = Math.max(box!.x + 10, targetX - 80);
    const startY = targetY;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    assert.equal(new URL(page.url()).pathname, "/map", "a drag ending on a pin must not navigate");
  });

  await t("a drag that starts on a pin does not navigate to it", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const pin = await pins.first().boundingBox();
    assert.ok(pin, "expected a pin to have a bounding box");

    const startX = pin!.x + pin!.width / 2;
    const startY = pin!.y + pin!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 70, startY + 45, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    assert.equal(new URL(page.url()).pathname, "/map", "a drag starting on a pin must not navigate");
  });

  // The complement of the two tests above, and the one that would catch
  // over-suppression: if draggedRef stayed set (or click suppression fired
  // unconditionally) a genuine tap would silently stop reaching the pin too,
  // and the drag-suppression tests would keep passing while the feature broke.
  //
  // CHANGED for the popup (feat/map-pin-popup): a plain click no longer
  // navigates directly, it opens the popup — so "the click reached the pin"
  // is now evidenced by the popup appearing, not by an immediate URL change.
  // Kept in the same test (rather than split) because that's still exactly
  // what it's proving: a plain click, despite a real click's inevitable
  // jitter, still fires the pin's own onClick. The second half — clicking the
  // popup itself navigates — is this test's original destination, just one
  // extra step away now that the click no longer skips straight there.
  await t(
    "clicking a pin still opens its popup with a pixel or two of jitter, and the popup navigates",
    async () => {
      await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
      await hydrated(page);
      await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
      const pins = page.locator('button[data-testid="map-pin"]');
      await pins.first().waitFor();
      const pin = await pins.first().boundingBox();
      assert.ok(pin, "expected a pin to have a bounding box");

      const cx = pin!.x + pin!.width / 2;
      const cy = pin!.y + pin!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      // A real click always wobbles a pixel or two between down and up. This
      // moves ~3.6px (Math.hypot(3, 2)) — comfortably under MapView's 6px
      // DRAG_SLOP — so the sequence still fires handlePointerMove without
      // arming drag-suppression. Without this move, handlePointerMove never
      // fires at all and DRAG_SLOP itself is never exercised (confirmed:
      // removing the DRAG_SLOP check survives the whole suite without it).
      await page.mouse.move(cx + 3, cy + 2);
      await page.mouse.up();

      const popup = page.locator('[data-testid="map-pin-popup"]');
      await popup.waitFor({ timeout: 5000 });
      assert.equal(await popup.count(), 1, "a plain click with jitter should open exactly one popup");

      await popup.click();
      await page.waitForURL(/\/property\//, { timeout: 5000 });
      assert.match(page.url(), /\/property\//, "clicking the popup should navigate to its property");
    },
  );

  // Regression: draggedRef must not outlive the gesture that armed it. A real
  // drag's pointerup almost always does produce a following click (Chromium
  // fires exactly one from a genuine mousedown/mouseup pair, retargeted to
  // whichever element holds pointer capture), which is why the two
  // drag-suppression tests above can rely on onClickCapture to clear the flag
  // normally. But a drag can also end via pointercancel (onPointerCancel is
  // wired to the same endDrag as onPointerUp) — the browser stops delivering
  // events for that gesture, capture is released, and NO click follows at
  // all. Confirmed empirically (see the pointer-capture repro used to verify
  // this fix): once capture is released outside of a click-producing
  // pointerup, a click on the map box genuinely never fires. Before this
  // gesture, if draggedRef were still cleared only inside handleClickCapture,
  // it would stay permanently armed and silently swallow the very next click.
  //
  // This is reproduced by ending a real drag with a genuine pointercancel
  // rather than pointerup: a synthetic 'pointercancel' dispatched on the map
  // box still reaches the real, registered onPointerCancel handler (dispatch
  // delivers to real listeners regardless of the dispatching event's
  // trusted-ness) and that handler makes a REAL releasePointerCapture() call,
  // which genuinely releases the browser's capture. Releasing the actual
  // mouse button afterwards, away from the map entirely, then produces a
  // click that has nowhere captured to be retargeted to — so it never
  // reaches the map box, and the drag's gesture truly ends with no click.
  await t("a drag cancelled without a click still allows the next click through", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const box = await mapBox().boundingBox();
    assert.ok(box, "expected the map box to have a bounding box");

    // Capture the real pointerId of the mouse gesture so the synthetic
    // pointercancel below can be dispatched for the SAME pointer the browser
    // is already tracking capture for.
    await page.evaluate(() => {
      const el = document.querySelector("div.touch-none")!;
      el.addEventListener(
        "pointerdown",
        (e) => {
          (window as unknown as { __pid: number }).__pid = (e as PointerEvent).pointerId;
        },
        { once: true },
      );
    });

    const startX = box!.x + 30;
    const startY = box!.y + 30;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Cross DRAG_SLOP for real, so the app takes real pointer capture.
    await page.mouse.move(startX + 60, startY + 40, { steps: 12 });

    // End the gesture via a genuine (if synthetically-dispatched) pointercancel
    // instead of pointerup — this is what the app's onPointerCancel handles,
    // and it releases capture for real.
    await page.evaluate(() => {
      const el = document.querySelector("div.touch-none")!;
      const pid = (window as unknown as { __pid: number }).__pid;
      el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: pid, bubbles: true, cancelable: true }));
    });

    // Release the real mouse button well away from the map box, so the click
    // this produces (capture already released) cannot land anywhere near it.
    await page.mouse.move(startX, box!.y - 60);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(new URL(page.url()).pathname, "/map", "the cancelled drag itself must not navigate");

    // Now a plain click on a pin, in the same page load. Pre-fix, draggedRef
    // is still armed from the cancelled drag above and this click gets
    // swallowed; post-fix, handlePointerDown resets it for the new gesture.
    //
    // CHANGED for the popup (feat/map-pin-popup): the click reaching the pin
    // is now evidenced by the popup opening rather than an immediate
    // navigation — see the jitter test above for the same change and why.
    const pin = await pins.first().boundingBox();
    assert.ok(pin, "expected a pin to have a bounding box after the cancelled drag");
    await page.mouse.move(pin!.x + pin!.width / 2, pin!.y + pin!.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    const popup = page.locator('[data-testid="map-pin-popup"]');
    await popup.waitFor({ timeout: 5000 });
    assert.equal(
      await popup.count(),
      1,
      "a plain click after a click-less cancelled drag should still open the popup",
    );
  });

  // --- pin popup: content, drag-suppression, navigation, close, replace -----

  await t("the popup shows the clicked pin's own address and price, not just any text", async () => {
    const { withImage } = mapPopupFixtures();
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');

    const idx = await pinIndex(withImage.address);
    await clickPin(idx);

    const popup = page.locator('[data-testid="map-pin-popup"]');
    await popup.waitFor();
    assert.equal(await popup.count(), 1, "expected exactly one popup to open");
    const text = await popup.innerText();
    assert.ok(
      text.includes(withImage.address),
      `expected the popup to show "${withImage.address}", got: ${JSON.stringify(text)}`,
    );
    // Via formatPrice — the same function MapView renders with — not a
    // hand-built price string, so a change to its formatting can't desync
    // silently from what this test expects.
    const expectedPrice = formatPrice(withImage.priceDisplay, withImage.priceNumeric);
    assert.ok(
      text.includes(expectedPrice),
      `expected the popup to show the price "${expectedPrice}", got: ${JSON.stringify(text)}`,
    );
  });

  // Edge case (brief): a property with no thumbPath must get the "no image"
  // fallback rather than a broken <img>. mapPopupFixtures() looks for a VIC
  // geocoded property with zero image rows at runtime; the fixture DB this
  // suite snapshots from data/app.db has none as of this run — every geocoded
  // VIC property has at least one non-excluded photo — so only the
  // has-an-image half is verified here. Recorded rather than faked: see the
  // console.log below if this ever runs against a DB where one exists.
  await t("popup shows a hero image when the property has one (and the fallback when it doesn't)", async () => {
    const { withImage, withoutImage } = mapPopupFixtures();
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');

    const idx = await pinIndex(withImage.address);
    await clickPin(idx);
    const popup = page.locator('[data-testid="map-pin-popup"]');
    await popup.waitFor();
    const img = popup.locator("img");
    assert.equal(await img.count(), 1, "expected the popup to render a hero image for a property that has one");
    // next/image rewrites src to /_next/image?url=<encoded>&..., so decode
    // before checking it still routes through the app's own /api/img handler.
    const src = await img.getAttribute("src");
    assert.ok(src, "expected the hero <img> to have a src");
    assert.ok(
      decodeURIComponent(src!).includes("/api/img/"),
      `expected the hero image to route through /api/img, got ${src}`,
    );

    if (!withoutImage) {
      console.log(
        "  (no VIC geocoded property without any images in the fixture DB — fallback half not verified)",
      );
      return;
    }

    await page.locator('button[aria-label="Close"]').click();
    await popup.waitFor({ state: "detached" });
    const idx2 = await pinIndex(withoutImage.address);
    await clickPin(idx2);
    await popup.waitFor();
    assert.equal(await popup.locator("img").count(), 0, "expected no <img> when the property has no thumbPath");
    assert.ok(await popup.getByText(/no image/i).isVisible(), "expected the 'no image' fallback text");
  });

  await t("a drag across a pin does not open the popup", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const box = await mapBox().boundingBox();
    const pin = await pins.first().boundingBox();
    assert.ok(box && pin, "expected both the map box and a pin to have bounding boxes");

    // Same shape as "a drag that ends over a pin does not navigate to it"
    // above — well past DRAG_SLOP, ending centred on the pin.
    const targetX = pin!.x + pin!.width / 2;
    const targetY = pin!.y + pin!.height / 2;
    const startX = Math.max(box!.x + 10, targetX - 80);
    const startY = targetY;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    assert.equal(
      await page.locator('[data-testid="map-pin-popup"]').count(),
      0,
      "a drag ending on a pin must not open the popup",
    );
  });

  await t("clicking the popup navigates to that exact property", async () => {
    const { withImage } = mapPopupFixtures();
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');

    const idx = await pinIndex(withImage.address);
    await clickPin(idx);
    const popup = page.locator('[data-testid="map-pin-popup"]');
    await popup.waitFor();
    await popup.click();
    await page.waitForURL((url) => url.pathname === `/property/${withImage.id}`, { timeout: 5000 });
    assert.equal(
      new URL(page.url()).pathname,
      `/property/${withImage.id}`,
      "clicking the popup should navigate to that exact property",
    );
  });

  await t("the popup closes via its close button and via Escape", async () => {
    const { withImage } = mapPopupFixtures();
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const popup = page.locator('[data-testid="map-pin-popup"]');
    const idx = await pinIndex(withImage.address);

    await clickPin(idx);
    await popup.waitFor();
    await page.locator('button[aria-label="Close"]').click();
    await popup.waitFor({ state: "detached" });
    assert.equal(await popup.count(), 0, "expected the close button to close the popup");

    await clickPin(idx);
    await popup.waitFor();
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "detached" });
    assert.equal(await popup.count(), 0, "expected Escape to close the popup");
  });

  await t("clicking a second pin replaces the popup rather than stacking", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();
    const n = await pins.count();
    assert.ok(n >= 2, "need at least two map pins to test popup replacement");
    const popup = page.locator('[data-testid="map-pin-popup"]');

    await clickPin(0);
    await popup.waitFor();
    assert.equal(await popup.count(), 1, "expected exactly one popup after the first click");
    // The accessible name (address + price) lives on the navigate link, not the
    // wrapping div — see the keyboard-reachability fix. It still distinguishes
    // properties just as well for this assertion.
    const firstLabel = await popup.locator("a").getAttribute("aria-label");

    await clickPin(1);
    await popup.waitFor();
    assert.equal(await popup.count(), 1, "expected exactly one popup after clicking a second pin — not stacked");
    const secondLabel = await popup.locator("a").getAttribute("aria-label");
    assert.notEqual(secondLabel, firstLabel, "expected the popup to now show the second pin's property");
  });

  // Regression: before this fix the popup's navigate surface was a bare `onClick` on a
  // `<div>` with no `tabIndex` — reachable by mouse only. Everything below is real
  // keyboard input (page.keyboard.press), never .click(). The one exception is focusing
  // the pin itself, which — per clickPin's rationale above — isn't the behaviour under
  // test; reaching the popup's own control via Tab, and activating it via Enter, is.
  await t("keyboard-only: Tab/Enter reaches the popup's navigate link and it reaches the property page", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const pins = page.locator('button[data-testid="map-pin"]');
    await pins.first().waitFor();

    // The popup renders as the pins' next DOM sibling (see the JSX), so once it's open,
    // Tab from the LAST pin reaches its close button first and its navigate link second —
    // two tabs, deterministic regardless of how many pins the map plots. Any other pin
    // would first have to tab through every pin after it.
    await pins.last().focus();
    await page.keyboard.press("Enter");
    const popup = page.locator('[data-testid="map-pin-popup"]');
    await popup.waitFor();

    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Close",
      "first Tab out of the pin should reach the popup's close button",
    );

    await page.keyboard.press("Tab");
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    assert.equal(focusedTag, "A", "second Tab should reach the popup's navigate link");

    await page.keyboard.press("Enter");
    await page.waitForURL(/\/property\//, { timeout: 5000 });
    assert.match(
      page.url(),
      /\/property\//,
      "activating the popup's navigate link by keyboard should reach the property page",
    );
  });

  await t("scrolling the wheel zooms the map, in and back out", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const box = await mapBox().boundingBox();
    assert.ok(box, "expected the map box to have a bounding box");
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const z0 = await tileZoom();
    // Negative deltaY (scroll up / wheel notch toward the user) must zoom IN.
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(150);
    const z1 = await tileZoom();
    assert.ok(z1 > z0, `scrolling up should zoom in (z0=${z0}, z1=${z1})`);

    // Positive deltaY (scroll down) must zoom back OUT.
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
    const z2 = await tileZoom();
    assert.ok(z2 < z1, `scrolling down should zoom back out (z1=${z1}, z2=${z2})`);
  });

  await t("zoom stays clamped to 3..18 even after extreme scrolling", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');
    const box = await mapBox().boundingBox();
    assert.ok(box, "expected the map box to have a bounding box");
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    await page.mouse.wheel(0, -6000);
    await page.waitForTimeout(200);
    const zMax = await tileZoom();
    assert.ok(zMax <= 18, `zoom must not exceed 18, got ${zMax}`);
    assert.equal(zMax, 18, `extreme zoom-in should clamp at 18, got ${zMax}`);

    await page.mouse.wheel(0, 6000);
    await page.waitForTimeout(200);
    const zMin = await tileZoom();
    assert.ok(zMin >= 3, `zoom must not drop below 3, got ${zMin}`);
    assert.equal(zMin, 3, `extreme zoom-out should clamp at 3, got ${zMin}`);
  });

  // Regression (sec-001): the wheel handler's accumulator loop —
  // `while (wheelAccum.current >= WHEEL_STEP) { ...; wheelAccum.current -=
  // WHEEL_STEP; }` — never terminates once `wheelAccum.current` is Infinity,
  // because `Infinity - WHEEL_STEP === Infinity` in IEEE-754 arithmetic. Real
  // mouse/trackpad hardware never reports a non-finite deltaY, but a script
  // already running in the page (e.g. a malicious extension) can construct
  // an event whose deltaY reads back as Infinity and dispatch it.
  //
  // `new WheelEvent("wheel", { deltaY: Infinity })` cannot be used to build
  // that event directly — confirmed empirically: WheelEventInit's deltaY is
  // WebIDL `double` (not `unrestricted double`), so the constructor throws a
  // TypeError ("The provided double value is non-finite") before the event
  // even exists. The construction below instead builds a normal event and
  // overrides `deltaY` afterwards with `Object.defineProperty`, which is
  // exactly the shape of object a page script could hand to `dispatchEvent`.
  //
  // Both `page.evaluate` calls below are raced against a plain `setTimeout`
  // rather than awaited directly: if the bug is present, the dispatch hangs
  // the page's script thread forever, and an un-raced `await` here would hang
  // this entire test run rather than failing this one test. The timeout lives
  // in Node, not the browser, so it fires regardless of whether the page's
  // JS thread is stuck.
  await t("a non-finite wheel deltaY must not hang the page (sec-001)", async () => {
    await page.goto(`${base}/map`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('img[src*="tile.openstreetmap.org"]');

    const dispatched = await Promise.race([
      page
        .evaluate(() => {
          const el = document.querySelector("div.touch-none")!;
          const ev = new WheelEvent("wheel", { deltaY: 10, bubbles: true, cancelable: true });
          Object.defineProperty(ev, "deltaY", { value: Infinity, configurable: true });
          el.dispatchEvent(ev);
        })
        .then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000)),
    ]);
    assert.ok(
      dispatched,
      "dispatching a wheel event with a non-finite deltaY hung the page — the accumulator loop " +
        "never terminates once deltaY is Infinity",
    );

    // Not just that the dispatch call itself returned — the page must still
    // be able to run a trivial script afterwards.
    const responsive = await Promise.race([
      page.evaluate(() => 1 + 1).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000)),
    ]);
    assert.ok(responsive, "page should still respond to a trivial evaluate after the non-finite wheel event");
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

  // Regression: TagSelect initialises its selection once via useState(roomType
  // ?? ""). Without `key={img.id}` on the <TagSelect> in Lightbox.tsx, React
  // reuses the same component instance across photos, so that initialiser
  // never re-runs and the dropdown keeps showing the PREVIOUS photo's room
  // after browsing to the next one — never guess a room, so a stale display
  // here is worse than a stale label.
  await t("room select shows the CURRENT photo's room after browsing to the next one", async () => {
    const { propertyId, index, roomA, roomB } = adjacentRoomChangePhoto();
    await page.setViewportSize(DESKTOP);
    await page.goto(`${base}/property/${propertyId}`, { waitUntil: "domcontentloaded" });
    await hydrated(page);
    const opener = page.locator('button[title="Open"]').nth(index);
    await opener.waitFor();
    await opener.click();
    const modal = page.locator("div.fixed.inset-0.z-\\[90\\]");
    await modal.waitFor();
    const counter = modal.locator("span.text-sm.text-neutral-300").first();
    const select = modal.locator("select");
    await select.waitFor();

    const counterBefore = await counter.innerText();
    assert.equal(
      await select.inputValue(),
      roomA,
      "lightbox should open on the clicked photo, showing its room",
    );

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    assert.notEqual(await counter.innerText(), counterBefore, "ArrowRight should have advanced the photo");
    assert.equal(
      await select.inputValue(),
      roomB,
      `after browsing to the next photo the room select must show ITS room (${roomB}), ` +
        `not the previous photo's (${roomA})`,
    );

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
  // Day-one state: both new columns NULL for every row (no backfill yet). The
  // "Year built" row still stays hidden with nothing to show, but the
  // property.com.au row must now ALWAYS render — falling back to a Google
  // search built from the address — since the enrichment column being empty
  // for every prod row is exactly the case this fallback exists for.
  await t("detail page falls back to a property.com.au search when the URL is NULL", async () => {
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
    await card.locator("dt", { hasText: "property.com.au" }).waitFor();
    const link = card.locator("a", { hasText: "Search property.com.au" });
    await link.waitFor();
    assert.equal(
      await page.locator("a", { hasText: "View listing" }).count(),
      0,
      "wording must not claim a listing was found when it's only a search",
    );
    const href = await link.getAttribute("href");
    assert.ok(href?.startsWith("https://www.google.com/search?"), "falls back to a scoped google search");
    assert.ok(
      decodeURIComponent(href ?? "").includes("site:property.com.au"),
      "search is scoped to the property.com.au site",
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
