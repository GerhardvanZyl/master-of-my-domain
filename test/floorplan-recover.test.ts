/**
 * Regression tests for the floorplan recovery pass — run 20260920-1449-bugfix,
 * round 1 findings req-001 (the hero rule), tech-002 (the bucket conflation)
 * and tech-003 (one bad fetch discarding the whole verification).
 *
 * req-001 is the one that reached live. scripts/floorplan-coverage.ts excluded
 * `ordinal === 0` for REA rows instead of the image the app actually leads
 * with, on the strength of a comment claiming "for REA, ordinal 0 IS the
 * hero". pickHero() never reads `ordinal`: its FIRST rung is the lowest
 * "Image N" parsed out of the alt text, and REA writes "Media Overview Image
 * 2" on the image at ordinal 1 while leaving ordinal 0 with no alt at all. So
 * the guard excluded an image pickHero would never have returned, left the
 * real hero in the candidate set, and a 0.6+ verdict wrote notes='floorplan'
 * over it. The fixture in "the live shape" below is 9 Butchart Close
 * (prop_927d99ebd31f) as it stood on 2026-09-20, dimensions and alt text
 * copied from the live rows.
 *
 * tech-002: a property whose every candidate FAILED to classify (LM Studio
 * down, /api/img erroring) was filed under `noCandidateStored` — the one
 * bucket SKILL.md tells the operator to STOP on and request a fresh browser
 * capture for, which needs the user's explicit approval. "Never looked at"
 * must not read as "go ask for a capture".
 *
 * tech-003: the >Floorplan< sweep in scripts/_verify-live.mjs threw on the
 * first non-OK page, and it runs ahead of every blocking check and the report
 * itself. The end-to-end case below proves the report still lands with one
 * page returning 500.
 *
 * No network and no local model: the classifier is injected for the unit
 * cases, and both end-to-end cases run the real scripts against a node:http
 * stub. The child processes get their own DB_PATH so the tracked data/app.db
 * is untouched by this file.
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  floorplanTagRow,
  recoverFloorplanForProperty,
  recoveryOutcome,
  splitOnRenderedHero,
  type FloorplanVerdict,
  type RecoverableImage,
} from "../scripts/lib/floorplan-recover";
import { scanRenderedFloorplans } from "../scripts/lib/floorplan-scan.mjs";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const COVERAGE_SCRIPT = path.join(REPO, "scripts/floorplan-coverage.ts");
const VERIFY_SCRIPT = path.join(REPO, "scripts/_verify-live.mjs");
const TSX_CLI = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

function img(over: Partial<RecoverableImage> & { id: string }): RecoverableImage {
  return {
    localPath: `${over.id}.jpg`,
    width: 1650,
    height: 1100,
    alt: null,
    sourceUrl: null,
    ordinal: 0,
    roomType: "other",
    notes: null,
    ...over,
  };
}

const verdict = (isFloorplan: boolean, confidence: number): FloorplanVerdict => ({
  isFloorplan,
  confidence,
  source: "model",
});

// --- req-001: which image is the hero -------------------------------------

// 9 Butchart Close as live served it: ordinal 0 is the 1650x1100 facade with
// no alt; ordinal 1 is the 768x512 floorplan carrying "Media Overview Image
// 2". Both are 3:2, so only the alt rung separates them.
const butchart = [
  img({ id: "img_1c77f4bf84f9", ordinal: 0, width: 1650, height: 1100, roomType: "exterior" }),
  img({
    id: "img_a8b73088453f",
    ordinal: 1,
    width: 768,
    height: 512,
    alt: "Media Overview Image 2",
  }),
  img({ id: "img_bbac14c08ba9", ordinal: 2, width: 768, height: 512, alt: "Media Overview Image 3" }),
];

{
  const { hero, candidates } = splitOnRenderedHero(butchart);
  assert.equal(
    hero?.id,
    "img_a8b73088453f",
    "the hero is what pickHero resolves (lowest alt Image N), not ordinal 0",
  );
  assert.ok(
    !candidates.some((c) => c.id === "img_a8b73088453f"),
    "the rendered hero must never be offered as a floorplan candidate",
  );
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["img_1c77f4bf84f9", "img_bbac14c08ba9"],
    "every other visible image stays a candidate",
  );
}

{
  // The repaired state: an explicit notes='hero' on the real cover wins the
  // first rung outright, which frees the floorplan to be tagged.
  const repaired = butchart.map((i) =>
    i.id === "img_1c77f4bf84f9" ? { ...i, notes: "hero" } : i,
  );
  const { hero, candidates } = splitOnRenderedHero(repaired);
  assert.equal(hero?.id, "img_1c77f4bf84f9", "an explicit hero tag wins");
  assert.ok(
    candidates.some((c) => c.id === "img_a8b73088453f"),
    "with the cover pinned, the floorplan becomes taggable again",
  );
}

{
  // The retired rule: a property with no notes='hero' anywhere used to be
  // skipped outright ("cannot safely identify the hero"). pickHero answers
  // that for tagged and untagged properties alike, so nothing is skipped now.
  const untagged = [
    img({ id: "a", width: 1620, height: 1080 }),
    img({ id: "b", width: 1620, height: 1080, ordinal: 1 }),
  ];
  const { hero, candidates } = splitOnRenderedHero(untagged);
  assert.equal(hero?.id, "a", "no explicit hero still resolves a hero");
  assert.deepEqual(candidates.map((c) => c.id), ["b"], "and the property is not skipped");
}

{
  // isVisibleImage runs first, so an excluded image is neither hero nor
  // candidate — tagging one would resurrect agency branding into the gallery.
  const withExcluded = [
    img({ id: "junk", roomType: "exclude" }),
    img({ id: "real", ordinal: 1 }),
    img({ id: "logo", width: 120, height: 42, ordinal: 2 }),
  ];
  const { hero, candidates } = splitOnRenderedHero(withExcluded);
  assert.equal(hero?.id, "real", "an exclude-tagged image can never be the hero");
  assert.deepEqual(candidates.map((c) => c.id), [], "nor a candidate, and neither can a logo strip");
}

// --- tech-002: a failed classification is not "no floorplan exists" -------

{
  const boom = async (): Promise<FloorplanVerdict> => {
    throw new Error("img 500");
  };
  const r = await recoverFloorplanForProperty({ images: butchart, classify: boom });
  assert.equal(r.candidates, 2, "both non-hero images were candidates");
  assert.equal(r.classified, 0, "none of them produced a verdict");
  assert.deepEqual(
    r.failedImageIds,
    ["img_1c77f4bf84f9", "img_bbac14c08ba9"],
    "the failures are attributed to the images, not a global counter",
  );
  assert.equal(r.best, null, "nothing to tag");
  assert.equal(
    recoveryOutcome(r),
    "notClassified",
    "every candidate failing means never looked at — NOT the STOP bucket",
  );
}

{
  // A mix stays in noCandidateStored (something was genuinely looked at and
  // was not a floorplan) but still carries the failed id so a re-run can be
  // targeted.
  const r = await recoverFloorplanForProperty({
    images: butchart,
    classify: async (i) => {
      if (i.id === "img_bbac14c08ba9") throw new Error("img 500");
      return verdict(false, 0.97);
    },
  });
  assert.equal(r.classified, 1, "one candidate was classified");
  assert.deepEqual(r.failedImageIds, ["img_bbac14c08ba9"], "the other is named");
  assert.equal(recoveryOutcome(r), "noCandidateStored", "a mix stays where it was");
}

{
  // No candidates at all is genuinely "nothing stored to look at", and must
  // not be confused with "the classifier fell over".
  const r = await recoverFloorplanForProperty({
    images: [img({ id: "only" })],
    classify: async () => verdict(true, 1),
  });
  assert.equal(r.candidates, 0, "the single visible image is the hero");
  assert.equal(recoveryOutcome(r), "noCandidateStored", "zero candidates is not notClassified");
}

{
  // Selection: the threshold is a floor, the most confident verdict wins, and
  // the room type is preserved rather than invented.
  const images = [
    img({ id: "hero" }),
    img({ id: "weak", ordinal: 1, roomType: "other" }),
    img({ id: "strong", ordinal: 2, roomType: "living" }),
    img({ id: "stronger", ordinal: 3, roomType: null }),
  ];
  const confidences: Record<string, FloorplanVerdict> = {
    weak: verdict(true, 0.59),
    strong: verdict(true, 0.7),
    stronger: verdict(true, 0.95),
  };
  const r = await recoverFloorplanForProperty({
    images,
    classify: async (i) => confidences[i.id] ?? verdict(false, 1),
  });
  assert.equal(r.best?.imageId, "stronger", "the most confident verdict over the threshold wins");
  assert.equal(recoveryOutcome(r), "recovered", "a best verdict is a recovery");
  assert.deepEqual(
    floorplanTagRow(r.best!),
    {
      imageId: "stronger",
      roomType: "other",
      confidence: 0.95,
      notes: "floorplan",
      taggedBy: "local-vlm",
      ifAbsent: false,
    },
    "floorplan is a notes value; a null roomType falls back to 'other', never to 'floorplan'",
  );

  const weakOnly = await recoverFloorplanForProperty({
    images,
    classify: async (i) => (i.id === "weak" ? confidences.weak : verdict(false, 1)),
  });
  assert.equal(weakOnly.best, null, "0.59 is below the 0.6 threshold and never tags");
}

// --- tech-003: the page sweep degrades, it does not throw ----------------

interface StubRoutes {
  [pathname: string]: { status?: number; body: string; json?: boolean };
}

async function startStub(routes: StubRoutes): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes[pathname];
    if (!route) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, {
      "content-type": route.json ? "application/json" : "text/html",
    });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function flightScript(rawJson: string): string {
  const inner = JSON.stringify(rawJson).slice(1, -1);
  return `<script>self.__next_f.push([1,"${inner}"])</script>`;
}

const page = (hasFloorplan: boolean, images: unknown[] = []) =>
  `<!doctype html><body>${hasFloorplan ? "<div>Floorplan</div>" : "<div>Photos</div>"}` +
  `${flightScript(`1:${JSON.stringify({ images })}`)}</body>`;

{
  const stub = await startStub({
    "/property/ok": { body: page(true) },
    "/property/missing": { body: page(false) },
    "/property/broken": { status: 500, body: "boom" },
  });
  try {
    const scan = await scanRenderedFloorplans(
      stub.url,
      [{ id: "ok" }, { id: "broken" }, { id: "missing" }],
      { concurrency: 2 },
    );
    assert.deepEqual(scan.missing.map((m) => m.id), ["missing"], "only the answered gap is missing");
    assert.equal(scan.scanned, 2, "the unreadable page is not counted as scanned");
    assert.equal(scan.errors.length, 1, "it is recorded instead");
    assert.equal(scan.errors[0].id, "broken", "and attributed");
  } finally {
    await stub.close();
  }
}

// --- end to end: the real scripts against a stub live app ----------------

function run(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 60000).unref();
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "floorplan-recover-"));
fs.mkdirSync(path.join(tmp, "data/harvest"), { recursive: true });

{
  // tech-002 end to end: one property, an explicit hero (so the pre-fix code
  // reached classification too, and the bucket is the only thing under test),
  // two candidates, and /api/img refusing every one of them.
  const images = [
    { id: "i0", localPath: "i0.jpg", ordinal: 0, width: 1650, height: 1100, alt: null,
      sourceUrl: null, roomType: "exterior", notes: "hero" },
    { id: "i1", localPath: "i1.jpg", ordinal: 1, width: 768, height: 512, alt: null,
      sourceUrl: null, roomType: "other", notes: null },
    { id: "i2", localPath: "i2.jpg", ordinal: 2, width: 768, height: 512, alt: null,
      sourceUrl: null, roomType: "other", notes: null },
  ];
  const stub = await startStub({
    "/": {
      body: flightScript(
        `1:${JSON.stringify({
          properties: [{ id: "p1", address: "1 Test St", sourceSite: "rea", state: "VIC" }],
        })}`,
      ),
    },
    "/sydney": { body: "<!doctype html><body>no rows</body>" },
    "/property/p1": { body: page(false, images) },
    "/api/img/p1/i1.jpg": { status: 500, body: "nope" },
    "/api/img/p1/i2.jpg": { status: 500, body: "nope" },
  });
  try {
    const r = await run([TSX_CLI, COVERAGE_SCRIPT], {
      cwd: tmp,
      env: {
        TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
        LIVE_BASE: stub.url,
        DATA_DIR: tmp,
        DB_PATH: path.join(tmp, "app.db"),
        REMOTE_IMG_DIR: path.join(tmp, "imgs"),
      },
    });
    assert.equal(r.status, 0, `floorplan-coverage must exit 0, stderr: ${r.stderr}`);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.missing, 1, "the property renders no floorplan");
    assert.equal(
      summary.notClassified,
      1,
      "every candidate erroring is its own bucket, not a capture request",
    );
    assert.equal(
      summary.noCandidateStored,
      0,
      "and must NOT be filed as 'nothing stored' — that is the STOP bucket",
    );
    assert.equal(summary.errored, 2, "both failed images are still counted");
    const report = JSON.parse(
      fs.readFileSync(path.join(tmp, "data/harvest/_floorplan-coverage.json"), "utf8"),
    );
    assert.deepEqual(
      report.notClassified[0].failedImageIds,
      ["i1", "i2"],
      "the report names the images to retry",
    );
  } finally {
    await stub.close();
  }
}

{
  // tests-r3-001: heroImageId on a noCandidateStored report entry. It lets an
  // operator tell "the floorplan IS the rendered hero" from "no floorplan
  // exists at all" without ever tagging the hero. A property whose only
  // visible image IS the hero has zero candidates, so no download or model
  // call is needed — recoveryOutcome files it under noCandidateStored and the
  // report must still carry the resolved hero id.
  const heroOnly = [
    { id: "h0", localPath: "h0.jpg", ordinal: 0, width: 1650, height: 1100, alt: null,
      sourceUrl: null, roomType: "exterior", notes: "hero" },
  ];
  const stub = await startStub({
    "/": {
      body: flightScript(
        `1:${JSON.stringify({
          properties: [{ id: "p2", address: "2 Test St", sourceSite: "rea", state: "VIC" }],
        })}`,
      ),
    },
    "/sydney": { body: "<!doctype html><body>no rows</body>" },
    "/property/p2": { body: page(false, heroOnly) },
  });
  try {
    const r = await run([TSX_CLI, COVERAGE_SCRIPT], {
      cwd: tmp,
      env: {
        TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json"),
        LIVE_BASE: stub.url,
        DATA_DIR: tmp,
        DB_PATH: path.join(tmp, "app.db"),
        REMOTE_IMG_DIR: path.join(tmp, "imgs2"),
      },
    });
    assert.equal(r.status, 0, `floorplan-coverage must exit 0, stderr: ${r.stderr}`);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.noCandidateStored, 1, "the only image is the hero, so there is no candidate");
    const report = JSON.parse(
      fs.readFileSync(path.join(tmp, "data/harvest/_floorplan-coverage.json"), "utf8"),
    );
    assert.equal(
      report.noCandidateStored[0].heroImageId,
      "h0",
      "the report names the resolved hero so an operator can tell the floorplan IS the rendered hero",
    );
  } finally {
    await stub.close();
  }
}

{
  // tech-003 end to end: the floorplan sweep sits ahead of every check() and
  // the report. One property page returning 500 must cost the sweep its
  // certainty about that row and nothing else.
  const vicRow = (id: string) => ({
    id,
    listingUrl: `https://www.domain.com.au/${id}`,
    address: `${id} Test St`,
    delisted: false,
    imageCount: 3,
    thumbPath: `images/${id}/a.jpg`,
    nearestStation: "Williams Landing",
    ptMinutesToFlinders: 31,
    latitude: -37.9,
    ptSteps: "train",
  });
  const nsw = Array.from({ length: 25 }, (_, i) => ({
    id: `n${i}`,
    listingUrl: `https://www.domain.com.au/n${i}`,
    address: `${i} Sydney St`,
    delisted: false,
    ptMinutesToFlinders: 20,
  }));
  const stub = await startStub({
    "/api/batch": {
      json: true,
      body: JSON.stringify({ ok: true, properties: 2, totalImages: 6, tagged: 6, untagged: 0 }),
    },
    "/": { body: flightScript(`1:${JSON.stringify({ properties: [vicRow("p1"), vicRow("p2")] })}`) },
    "/sydney": { body: flightScript(`1:${JSON.stringify({ properties: nsw })}`) },
    "/property/p1": { body: page(true) },
    "/property/p2": { status: 500, body: "boom" },
  });
  try {
    const r = await run([VERIFY_SCRIPT, stub.url], { cwd: tmp, env: {} });
    const reportPath = path.join(tmp, "data/harvest/_verify-live.json");
    assert.ok(
      fs.existsSync(reportPath),
      `the report must survive an unreadable property page, stderr: ${r.stderr}`,
    );
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.deepEqual(report.FAILURES, [], "no blocking check failed on this fixture");
    assert.equal(r.status, 0, "so the script exits 0 rather than dying mid-sweep");
    assert.equal(report.liveNoFloorplan, 0, "the readable page has a floorplan");
    assert.deepEqual(
      report.floorplanScanErrors.map((e: { id: string }) => e.id),
      ["p2"],
      "the unreadable page is surfaced as unknown, not silently counted either way",
    );
    assert.equal(report.liveNoStation, 0, "the blocking checks after the sweep still ran");
  } finally {
    await stub.close();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ floorplan-recover.test: all assertions passed");
