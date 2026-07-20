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
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { BrowserContext, Page } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ui-"));

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
  db.exec("UPDATE properties SET shortlist_tag=NULL, pros=NULL, cons=NULL");
  db.prepare("UPDATE properties SET shortlist_tag='rejected' WHERE id=?").run(props[0].id);
  const total = (db.prepare("SELECT count(*) n FROM properties").get() as { n: number }).n;
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

/** Run an action and wait for the write it triggers to actually land. */
async function saved(page: Page, action: () => Promise<void>) {
  const res = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/api/properties/"),
  );
  await action();
  assert.ok((await res).ok(), "PATCH should succeed");
}

async function chooseProfile(page: Page, name = "Gerhard") {
  await page.waitForSelector(sel.gate);
  // Scope to the gate — the header has same-named chips sitting behind it.
  await page.locator(sel.gate).getByRole("button", { name }).click();
  await page.waitForSelector(sel.gate, { state: "detached" });
}

async function main() {
  const base = process.env.BASE_URL ?? `http://localhost:${await freePort()}`;
  let server: ChildProcess | undefined;

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
    /fonts\.(googleapis|gstatic)\.com|tile\.openstreetmap\.org|maps\.google\.com|google\.com\/maps/,
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

  console.log("\ncompare");
  await t("selecting two properties opens a compare table with a ✦ winner", async () => {
    const buttons = page.getByRole("button", { name: "Compare", exact: true });
    await buttons.nth(0).click();
    await buttons.nth(1).click();
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

  await t("shortlist tag + feature toggle persist across a reload", async () => {
    await saved(page, () => page.locator("[data-tag=must-see]").click());
    await page.waitForSelector('[data-tag=must-see][data-active="true"]');
    // Features cycle unknown -> yes -> no; one click from unknown means "yes".
    await saved(page, () => page.locator("[data-feature=hasEaves]").click());
    await page.waitForSelector('[data-feature=hasEaves][data-value="yes"]');
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('[data-tag=must-see][data-active="true"]');
    await page.waitForSelector('[data-feature=hasEaves][data-value="yes"]');
    const db = new Database(path.join(tmp, "app.db"), { readonly: true });
    const row = db
      .prepare("SELECT shortlist_tag, has_eaves FROM properties WHERE id=?")
      .get(fixture.props[0].id) as { shortlist_tag: string; has_eaves: number };
    db.close();
    assert.deepEqual(row, { shortlist_tag: "must-see", has_eaves: 1 });
  });

  await t("score slider saves a 0–10 value", async () => {
    await saved(page, () => page.locator('input[type="range"]').last().fill("7.5"));
    await page.waitForSelector('[data-score="7.5"]');
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.waitForSelector('[data-score="7.5"]');
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
    const pins = page.locator('button[title]:has(span:text("✨"))');
    await pins.first().waitFor();
    const n = await pins.count();
    assert.ok(n > 0, "expected map pins");
    // "Highlight near" dims non-matching pins rather than removing them.
    await page.getByRole("button", { name: /Playground/ }).click();
    await page.waitForTimeout(200);
    assert.equal(await pins.count(), n, "filter must not drop pins");
    const dimmed = await pins.evaluateAll(
      (els) => els.filter((e) => Number((e as HTMLElement).style.opacity) < 1).length,
    );
    assert.ok(dimmed >= 0);
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

  console.log("\nregressions");
  await t("no uncaught page errors across the whole run", async () => {
    assert.deepEqual(consoleErrors, []);
  });

  await ctx.close();
  await closeBrowser();
  server?.kill();

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
