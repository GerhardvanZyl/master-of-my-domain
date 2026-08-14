/**
 * Offline test of the shared settings store (src/db/queries/settings.ts) and
 * the /api/config route it backs — the DB-of-record for the vibes-score
 * weights (see src/lib/vibes.ts). Temp DB, set BEFORE importing app modules,
 * same pattern as shares.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-settings-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { getSetting, putSetting } = await import("../src/db/queries/settings");
  const { DEFAULT_VIBE_CONFIG, parseVibeConfig } = await import("../src/lib/vibes");
  const { GET: configGet, PUT: configPut } = await import("../src/app/api/config/route");
  migrate();

  // ---------------------------------------------------------------------
  // Query layer
  // ---------------------------------------------------------------------

  // --- absent key reads back null ---
  assert.equal(getSetting("vibeConfig"), null, "no row yet -> null");

  // --- put then get round-trips ---
  putSetting("vibeConfig", { baseScore: 1234, idealPrice: 900_000 });
  assert.deepEqual(
    getSetting("vibeConfig"),
    { baseScore: 1234, idealPrice: 900_000 },
    "round trip through JSON.stringify/parse",
  );

  // --- put again upserts the same row, doesn't duplicate ---
  putSetting("vibeConfig", { baseScore: 5678 });
  const rowCount = (
    sqlite.prepare("SELECT COUNT(*) c FROM settings WHERE key = ?").get("vibeConfig") as { c: number }
  ).c;
  assert.equal(rowCount, 1, "second put upserts in place");
  assert.deepEqual(getSetting("vibeConfig"), { baseScore: 5678 }, "second put's value wins");

  // --- a hand-corrupted row comes back as null, not a throw ---
  sqlite
    .prepare("INSERT OR REPLACE INTO settings (key, json, updated_at) VALUES (?, ?, ?)")
    .run("corrupt", "{not valid json", new Date().toISOString());
  assert.equal(getSetting("corrupt"), null, "malformed JSON -> null, not a throw");

  // --- and parseVibeConfig turns that null (or any partial/garbage value)
  // into a complete, finite-number config, never NaNs the grid ---
  assert.deepEqual(
    parseVibeConfig(getSetting("corrupt")),
    DEFAULT_VIBE_CONFIG,
    "corrupt stored value -> full default config via parseVibeConfig",
  );
  assert.deepEqual(
    parseVibeConfig({ baseScore: 42, idealPrice: "not a number", extraJunk: true }),
    { ...DEFAULT_VIBE_CONFIG, baseScore: 42 },
    "partial/garbage object -> complete config, bad fields dropped to default, unknown keys dropped",
  );

  // ---------------------------------------------------------------------
  // /api/config route
  // ---------------------------------------------------------------------

  // --- GET with no row stored -> the default config ---
  sqlite.exec("DELETE FROM settings WHERE key = 'vibeConfig'");
  {
    const res = await configGet();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { vibeConfig: unknown };
    assert.deepEqual(body.vibeConfig, DEFAULT_VIBE_CONFIG, "absent row -> defaults");
  }

  // --- PUT stores a gated value, and GET reflects it ---
  {
    const res = await configPut(
      new Request("http://localhost:3225/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...DEFAULT_VIBE_CONFIG, baseScore: 2000, idealPrice: 950_000 }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; vibeConfig: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.vibeConfig.baseScore, 2000);
    assert.equal(body.vibeConfig.idealPrice, 950_000);
  }
  {
    const res = await configGet();
    const body = (await res.json()) as { vibeConfig: Record<string, unknown> };
    assert.equal(body.vibeConfig.baseScore, 2000, "PUT persisted, GET reads it back");
  }

  // --- PUT with junk in the body still 200s with a full, gated default config
  // (the trust boundary is parseVibeConfig, not a 400) ---
  {
    const res = await configPut(
      new Request("http://localhost:3225/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseScore: "not a number", hacked: true }),
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { vibeConfig: Record<string, unknown> };
    assert.equal(body.vibeConfig.baseScore, DEFAULT_VIBE_CONFIG.baseScore, "bad field falls back to default");
    assert.equal(body.vibeConfig.hacked, undefined, "unknown key never reaches storage");
    const stored = getSetting("vibeConfig");
    assert.equal((stored as Record<string, unknown>).hacked, undefined, "unknown key never persisted either");
  }

  // --- literal invalid JSON body -> 400, not a 500 ---
  {
    const res = await configPut(
      new Request("http://localhost:3225/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    assert.equal(res.status, 400, "invalid JSON body -> 400");
  }

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ settings.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ settings.test FAILED:", e);
  process.exit(1);
});
