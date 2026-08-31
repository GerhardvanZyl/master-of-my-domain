/**
 * Regression test for tech-002 (round 1 of 20260823-1800-fix-tagging-round-
 * defects): scripts/_groups-from-tags.mjs's per-property duplicate guard
 * failed OPEN on every parse failure. A chip regex/flight-prop rename that
 * matches nothing reads identically to "the group is genuinely empty" --
 * both give back zero members -- and the script wrote an unguarded payload,
 * exit 0, no warning.
 *
 * This runs the actual script as a child process against a stub HTTP server
 * whose GET /rooms?group=<id> response OMITS the "columns" flight-stream
 * anchor entirely -- a renamed prop, a truncated stream, or an error page
 * rendered instead of the real one, none of which produce a valid empty
 * array. That is the parse-failure signal (round 2, arch-003): extractArray
 * (_live-http.mjs) throws when the anchor is absent rather than silently
 * returning `[]`, which is what let a genuine parse failure read identically
 * to "the group has 0 members" in round 1. (A round-1-shaped fixture --
 * anchor PRESENT with an empty array, alongside a non-zero /api/batch
 * `members` count -- is no longer ambiguous: confirmed live that /rooms
 * serialises `"columns":[]` even for a genuinely empty group, so that shape
 * is treated as empty, not a parse failure; see arch-003's notes on why
 * comparing it against /api/batch's unfiltered membership-row count was the
 * wrong signal.) A correct implementation must refuse to write rather than
 * silently treat an unparseable read as "the group has 0 members".
 *
 * Also covers tech-005/arch-005 (round 3): extractArray's OTHER silent-empty
 * exit -- the anchor is present but the bracket matcher never finds its
 * close ("truncated" below) -- must fail closed the same way anchor-absence
 * does, not read as "the group has 0 members".
 *
 * IMPORTANT: uses `spawn` (async), not `spawnSync`. A real node:http server
 * hosted in THIS test process cannot answer the child's requests while
 * spawnSync blocks this process's event loop for the child's entire
 * lifetime -- the child's request sits unaccepted until its own timeout
 * fires, which looks identical to a correct fail-closed exit (nonzero
 * status, no output file) regardless of whether the guard logic is actually
 * correct. Confirmed empirically while writing this test: the spawnSync
 * version "passed" in ~15s against BOTH the old fail-open code and a
 * deliberately-broken guard, because it was really timing out, not
 * asserting anything. See test/local-llm.test.ts's fetchStubPreloadUrl
 * comment, which documents the same spawnSync limitation independently.
 * `spawn` + await does not block this process, so the stub server keeps
 * servicing requests for the child's whole run.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/_groups-from-tags.mjs", import.meta.url));

/** Build a `self.__next_f.push([1,"..."])` chunk whose escaped payload,
 * once unescaped by _live-http.mjs's fetchFlightFlat, equals `rawJson`. */
function flightScript(rawJson: string): string {
  const inner = JSON.stringify(rawJson).slice(1, -1);
  return `<script>self.__next_f.push([1,"${inner}"])</script>`;
}

/** "malformed" simulates a genuine parse failure: the flight chunk is
 * present, but under a key other than "columns" (a renamed prop, a
 * truncated/garbled stream) -- so extractArray's anchor lookup finds nothing,
 * distinct from a legitimate empty array (see the file header). */
type ColumnsFixture = { propertyId: string }[] | "malformed" | "truncated";

async function startStub(
  groupsResponse: { id: string; label: string; members: number }[],
  columnsByGroup: Record<string, ColumnsFixture>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/api/batch") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ groups: groupsResponse }));
      return;
    }
    const groupId = u.searchParams.get("group");
    if (u.pathname === "/rooms" && groupId && groupId in columnsByGroup) {
      const fixture = columnsByGroup[groupId];
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        fixture === "malformed"
          ? flightScript(`1:${JSON.stringify({ notColumns: [] })}`)
          : fixture === "truncated"
            ? // The "columns":[ anchor is present, but the array literal never
              // closes before the chunk ends -- extractArray's OTHER
              // silent-empty exit (tech-005/arch-005, round 3).
              flightScript(`1:{"heading":"x","columns":[{"propertyId":"pid-existing-1"`)
            : flightScript(`1:${JSON.stringify({ columns: fixture })}`),
      );
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Runs the real script as a child process; does not block this process's
 * event loop (see the file header for why that matters here). */
function runScript(url: string, outFile: string, tagsFile: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, outFile, tagsFile], {
      env: { ...process.env, LIVE_BASE: url },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (status) => resolve({ status, stderr }));
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 15000).unref();
  });
}

function writeTagsFixture(dir: string): string {
  const tagsFile = path.join(dir, "tags.json");
  // Two candidates for the "kitchen" group: one new property, and one whose
  // pid is already a member in the positive case's stub (pid-existing-1).
  // The second one is what makes tests-004's regression protection real: with
  // the case-fold intact (arch-001 -> arch-004's groupInfoByLabel lookup) the
  // existing member is excluded and only img_new appears; with the case-fold
  // broken the "kitchen" lookup misses, `already` reads empty, and
  // pid-existing-1's image is wrongly re-added as a second row -- the two
  // outcomes then differ, which a single always-new candidate could not show
  // (tests-004, round 2).
  fs.writeFileSync(
    tagsFile,
    JSON.stringify({
      tags: [
        { propertyId: "pid-new", ordinal: 0, imageId: "img_new", roomType: "kitchen" },
        { propertyId: "pid-existing-1", ordinal: 0, imageId: "img_existing_1_dup", roomType: "kitchen" },
      ],
    }),
  );
  return tagsFile;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-groups-"));

  // --- Negative case: the group's /rooms membership read is unparseable
  // (the "columns" anchor is absent) -- a parse failure, not a genuinely
  // empty group. Must fail closed. ---
  {
    const tagsFile = writeTagsFixture(tmp);
    const outFile = path.join(tmp, "out-ambiguous.json");
    const { url, close } = await startStub(
      [{ id: "grp_kitchen", label: "kitchen", members: 429 }],
      { grp_kitchen: "malformed" },
    );
    try {
      const result = await runScript(url, outFile, tagsFile);
      assert.notEqual(
        result.status,
        0,
        "must fail closed (nonzero exit) when a group's membership read is unparseable (anchor absent)",
      );
      assert.ok(!fs.existsSync(outFile), "must not write an unguarded payload when membership could not be verified");
    } finally {
      await close();
    }
  }

  // --- Negative case, other shape: the "columns" anchor IS present but the
  // array literal never closes (a response truncated mid-array) --
  // tech-005/arch-005 (round 3): this used to read as "0 members" and write
  // an unguarded payload, exit 0, with /api/batch reporting 429 members for
  // the same group. Must fail closed exactly like the anchor-absent case. ---
  {
    const tagsFile = writeTagsFixture(tmp);
    const outFile = path.join(tmp, "out-truncated.json");
    const { url, close } = await startStub(
      [{ id: "grp_kitchen", label: "kitchen", members: 429 }],
      { grp_kitchen: "truncated" },
    );
    try {
      const result = await runScript(url, outFile, tagsFile);
      assert.notEqual(
        result.status,
        0,
        "must fail closed (nonzero exit) when a group's membership read is truncated mid-array",
      );
      assert.ok(
        !fs.existsSync(outFile),
        "must not write an unguarded payload when a truncated read could not be verified",
      );
    } finally {
      await close();
    }
  }

  // --- Positive case, same shape: /api/batch and the membership read agree
  // (a handful of members, all reported), so the guard must NOT fail closed
  // -- proves the fix isn't just "always refuse". ---
  {
    const tagsFile = writeTagsFixture(tmp);
    const outFile = path.join(tmp, "out-verified.json");
    const { url, close } = await startStub(
      [{ id: "grp_kitchen", label: "Kitchen", members: 2 }], // uppercase label: tech-003
      { grp_kitchen: [{ propertyId: "pid-existing-1" }, { propertyId: "pid-existing-2" }] },
    );
    try {
      const result = await runScript(url, outFile, tagsFile);
      assert.equal(result.status, 0, `must succeed when membership is verifiable, got stderr: ${result.stderr}`);
      const written = JSON.parse(fs.readFileSync(outFile, "utf8"));
      assert.deepEqual(
        written.groups,
        [{ label: "kitchen", roomType: "kitchen", imageIds: ["img_new"] }],
        "the new (non-duplicate) candidate is written once membership is verified, " +
          "even though /api/batch's label is uppercase",
      );
    } finally {
      await close();
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✓ groups-from-tags.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ groups-from-tags.test FAILED:", e);
  process.exit(1);
});
