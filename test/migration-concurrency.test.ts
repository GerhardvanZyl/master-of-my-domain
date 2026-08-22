/**
 * Concurrency race for `migrateColumns` (src/db/ddl.ts).
 *
 * The bug: every guard in migrateColumns was check-then-act with no lock —
 * read table_info, decide, then exec. Two processes that both read before
 * either writes both decide "needs migrating" and the loser dies with
 * `duplicate column name: viewed`. A busy_timeout does not help: the two
 * processes were never contending for a lock, the second one's decision was
 * simply stale by the time it ran.
 *
 * Harness (the shape specified in the review brief): process A takes
 * `BEGIN IMMEDIATE` directly on a fixture DB and applies the viewed-column
 * migration statements by hand, then HOLDS the transaction open for
 * `HOLD_MS`. While it holds the write lock, a real child process is spawned
 * that calls the real `migrateColumns` against the same file with a
 * `busy_timeout` well beyond `HOLD_MS`. A then commits.
 *
 * Proving the child overlapped A (not just "ran and didn't throw"): the
 * child times its own call to migrateColumns() with Date.now(). Under WAL, a
 * plain read (table_info) is never blocked by a pending writer — so
 * migrateColumns' own pre-check and, for the old code, its check-then-act
 * read both complete almost immediately after the child starts, regardless
 * of A's lock. The ONLY thing in either implementation that can block on A's
 * lock is the write itself (BEGIN IMMEDIATE, or the ALTER TABLE inside the
 * old code's own BEGIN). So if the child's migrateColumns() call takes close
 * to HOLD_MS, that time was spent waiting on A's lock — which means the
 * child's decision-making read necessarily happened before A committed, not
 * after. A short elapsed time would mean the child ran (and read) entirely
 * after A was done, which is the "didn't actually overlap" failure mode this
 * guards against.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { DDL } from "../src/db/ddl";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOLD_MS = 2000;
const CHILD_BUSY_TIMEOUT_MS = 15_000;

// Lives inside the project tree (not os.tmpdir()) purely so the spawned
// child's plain `import "better-sqlite3"` resolves via normal node_modules
// ancestor lookup. Cleaned up unconditionally in main()'s finally.
const scratchDir = path.join(ROOT, ".migration-race-scratch");

const CHILD_RUNNER = `
import { pathToFileURL as toUrl } from "node:url";
import Database from "better-sqlite3";

const [, , dbPath, ddlModulePath, busyTimeoutRaw] = process.argv;
const busyTimeout = Number(busyTimeoutRaw);
const { migrateColumns } = await import(toUrl(ddlModulePath).href);

const db = new Database(dbPath);
db.pragma(\`busy_timeout = \${busyTimeout}\`);

const start = Date.now();
try {
  migrateColumns(db);
  console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - start }));
} catch (err) {
  console.log(
    JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
db.close();
`;

/**
 * A fixture that already has viewed_at (rename is a no-op) and lacks
 * `viewed` — the variant the brief calls out as the one that reproduces
 * `duplicate column name: viewed` specifically.
 *
 * Also drops one column from each of the other three check-then-act sites in
 * migrateColumns (the ~30-column `add` map, property_ratings.score,
 * images.alt), because every fixture built straight from the current DDL
 * already has all of them and those three sites would otherwise be a no-op in
 * every run of this suite — untested despite sharing the exact same
 * check-then-act race as the `viewed` site. `domain_notes` stands in for the
 * `add` map; any entry in it exercises the same loop.
 */
function buildFixture(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  db.exec("ALTER TABLE properties DROP COLUMN viewed");
  db.exec("ALTER TABLE properties DROP COLUMN domain_notes");
  db.exec("ALTER TABLE property_ratings DROP COLUMN score");
  db.exec("ALTER TABLE images DROP COLUMN alt");
  const insert = db.prepare(
    `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at, viewed_at, shortlist_tag)
     VALUES (?, 'domain', ?, '2026-01-01', '2026-01-01', '2026-01-01', ?, ?)`,
  );
  insert.run("a", "https://x/a", "2026-08-01T00:00:00.000Z", null); // attended
  insert.run("b", "https://x/b", null, "must-see"); // wanted, never attended
  db.close();
}

interface ChildResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

async function runRace(ddlModulePath: string, tmpDir: string) {
  const dbPath = path.join(tmpDir, "race.db");
  buildFixture(dbPath);

  const runnerPath = path.join(scratchDir, "child-runner.mjs");

  // Process A: BEGIN IMMEDIATE directly (not via migrateColumns — A is
  // standing in for "some other process/worker got there first"), apply the
  // viewed-column migration by hand, and hold the write lock open.
  const a = new Database(dbPath);
  a.pragma("busy_timeout = 5000");
  a.exec("BEGIN IMMEDIATE");
  a.exec("ALTER TABLE properties ADD COLUMN viewed TEXT");
  a.exec("UPDATE properties SET viewed = 'viewed'  WHERE viewed_at IS NOT NULL");
  a.exec("UPDATE properties SET viewed = 'to-view' WHERE viewed IS NULL AND shortlist_tag = 'must-see'");
  a.exec("UPDATE properties SET shortlist_tag = NULL WHERE shortlist_tag = 'must-see'");

  // Invoke tsx's own CLI entry via node directly rather than through
  // npx(.cmd) + shell:true: with a shell, Windows' cmd.exe re-tokenizes the
  // command line on whitespace, and this repo's path ("...\Projects 2024\...")
  // contains a space — every argument after it was silently mangled, so the
  // child failed to resolve its own entry module and the race never actually
  // ran. Spawning node with an argv array needs no shell and no quoting.
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(
    process.execPath,
    [tsxCli, runnerPath, dbPath, ddlModulePath, String(CHILD_BUSY_TIMEOUT_MS)],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  // Attached BEFORE the hold, not after: if the child exits early (e.g. it
  // fails fast on SQLITE_BUSY well inside HOLD_MS), a listener attached after
  // the hold would attach to an EventEmitter that already fired "exit" to
  // nobody — Node discards it, the awaited promise below never resolves, and
  // the whole test silently hangs/exits without ever reaching an assertion.
  const exitPromise: Promise<number> = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });

  // Hold the lock for HOLD_MS while the child is presumably blocked inside
  // its own busy-wait, then release it.
  await new Promise((r) => setTimeout(r, HOLD_MS));
  a.exec("COMMIT");
  a.close();

  const exitCode = await exitPromise;

  let parsed: ChildResult | null = null;
  try {
    parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "");
  } catch {
    // leave parsed null; reported via the raw stdout/stderr below
  }

  return { exitCode, parsed, stdout, stderr, dbPath };
}

async function main() {
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(path.join(scratchDir, "child-runner.mjs"), CHILD_RUNNER);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-race-"));
  try {
    // Defaults to the current module; pass a path (e.g. an extracted old
    // revision of ddl.ts) as argv[2] to run the same race against it, which is
    // how this harness is used to prove the race actually reproduces.
    const ddlModulePath = process.argv[2]
      ? path.resolve(process.argv[2])
      : path.join(ROOT, "src", "db", "ddl.ts");
    const { exitCode, parsed, stdout, stderr, dbPath } = await runRace(ddlModulePath, tmpDir);

    assert.equal(exitCode, 0, `child process should exit cleanly; stderr:\n${stderr}`);
    assert.ok(parsed, `child produced unparseable output: ${stdout}\nstderr: ${stderr}`);
    assert.equal(parsed!.ok, true, `child's migrateColumns() should not throw; got: ${parsed!.error}`);

    // Overlap proof: the child's own timed call to migrateColumns() must
    // span most of A's hold — see the header comment for why that is sound
    // evidence the child's decision-making read happened before A committed,
    // not after.
    assert.ok(
      parsed!.elapsedMs >= HOLD_MS * 0.7,
      `child's migrateColumns() returned in ${parsed!.elapsedMs}ms, well under the ${HOLD_MS}ms A held the ` +
        `lock — it likely ran entirely after A committed rather than overlapping it`,
    );

    // No duplicate-column corruption, and the backfill A applied is intact —
    // the child must have found the work already done and skipped it, not
    // redone the ALTER (which SQLite would have refused outright).
    const check = new Database(dbPath, { readonly: true });
    const cols = (check.pragma("table_info(properties)") as Array<{ name: string }>).map((c) => c.name);
    assert.equal(cols.filter((c) => c === "viewed").length, 1, "viewed column must exist exactly once");
    const rows = new Map(
      (check.prepare("SELECT id, viewed, shortlist_tag FROM properties").all() as Array<Record<string, unknown>>).map(
        (r) => [r.id as string, r],
      ),
    );
    assert.equal(rows.get("a")!.viewed, "viewed", "attended row backfilled correctly");
    assert.equal(rows.get("b")!.viewed, "to-view", "must-see row backfilled correctly");
    assert.equal(rows.get("a")!.shortlist_tag, null, "must-see cleared");
    assert.equal(rows.get("b")!.shortlist_tag, null, "must-see cleared");

    // The other three check-then-act sites (see buildFixture) must also have
    // survived the same race, exactly once each, exercised by the child's
    // real migrateColumns() rather than by A's hand-applied statements.
    assert.equal(cols.filter((c) => c === "domain_notes").length, 1, "domain_notes column must exist exactly once");
    const ratingCols = (check.pragma("table_info(property_ratings)") as Array<{ name: string }>).map((c) => c.name);
    assert.equal(ratingCols.filter((c) => c === "score").length, 1, "score column must exist exactly once");
    const imageCols = (check.pragma("table_info(images)") as Array<{ name: string }>).map((c) => c.name);
    assert.equal(imageCols.filter((c) => c === "alt").length, 1, "alt column must exist exactly once");
    check.close();

    console.log(
      `✓ migration-concurrency.test: child overlapped A's ${HOLD_MS}ms hold (elapsed ${parsed!.elapsedMs}ms), ` +
        "returned cleanly, no duplicate column, backfill correct",
    );
  } finally {
    // Windows sometimes holds a locked-file handle open for a beat after
    // close() returns; retry rather than let a flaky cleanup mask a real
    // assertion failure from the try block above.
    for (const dir of [tmpDir, scratchDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (cleanupErr) {
        console.error(`cleanup warning: could not remove ${dir}:`, cleanupErr);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
