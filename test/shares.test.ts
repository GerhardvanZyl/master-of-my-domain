/**
 * Offline test of the shares feature: query-layer (upsert-on-reshare, unread
 * count, sort order, scoped mark-read) plus API-boundary validation on the
 * route handlers themselves (constructed Request, no server boot — same
 * pattern as ingest.test.ts). Temp DB, set BEFORE importing app modules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-shares-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { upsertShare, unreadShareCount, listSharesForProfile, markSharesRead } = await import(
    "../src/db/queries/shares"
  );
  const { GET: sharesGet, POST: sharesPost } = await import("../src/app/api/shares/route");
  const { POST: readPost } = await import("../src/app/api/shares/read/route");
  migrate();

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
       VALUES (?, 'domain', 'https://example.com/listing-1', ?, ?, ?)`,
    )
    .run("prop1", now, now, now);

  // ---------------------------------------------------------------------
  // Query layer
  // ---------------------------------------------------------------------

  // --- unread count starts at zero ---
  assert.equal(unreadShareCount("partner"), 0, "no shares yet");

  // --- sharing creates one unread row ---
  upsertShare({ propertyId: "prop1", fromProfile: "gerhard", toProfile: "partner", note: "look at this one" });
  assert.equal(unreadShareCount("partner"), 1, "one unread share after sharing");

  const inbox1 = listSharesForProfile("partner");
  assert.equal(inbox1.length, 1, "inbox has one property");
  assert.equal(inbox1[0].id, "prop1", "same PropertyListItem shape, keyed by property id");
  assert.equal(inbox1[0].share.fromProfile, "gerhard");
  assert.equal(inbox1[0].share.note, "look at this one");
  assert.equal(inbox1[0].share.readAt, null, "starts unread");

  // --- marking read by id clears the unread count, and leaves other profiles alone ---
  upsertShare({ propertyId: "prop1", fromProfile: "gerhard", toProfile: "other", note: null });
  assert.equal(unreadShareCount("other"), 1, "second recipient has an unread share before marking");
  const partnerShareId = listSharesForProfile("partner")[0].share.id;
  markSharesRead("partner", [partnerShareId]);
  assert.equal(unreadShareCount("partner"), 0, "read after markSharesRead");
  assert.notEqual(listSharesForProfile("partner")[0].share.readAt, null, "readAt is now set");
  assert.equal(unreadShareCount("other"), 1, "marking partner's share read does not touch other's share");

  // --- marking read only affects the given ids, not every unread row for the profile ---
  sqlite
    .prepare(
      `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
       VALUES (?, 'domain', 'https://example.com/listing-2', ?, ?, ?)`,
    )
    .run("prop2", now, now, now);
  upsertShare({ propertyId: "prop2", fromProfile: "gerhard", toProfile: "partner", note: null });
  const bothUnread = listSharesForProfile("partner").filter((s) => s.share.readAt == null);
  assert.equal(bothUnread.length, 1, "sanity: exactly one fresh unread share for partner (prop1 already read above)");
  const onlyId = bothUnread[0].share.id;
  markSharesRead("partner", [onlyId]);
  assert.equal(unreadShareCount("partner"), 0, "the targeted id is marked read");
  assert.equal(unreadShareCount("other"), 1, "an id list scoped to partner never touches other's rows");

  // --- re-sharing the SAME property to the SAME profile upserts, not duplicates ---
  upsertShare({ propertyId: "prop1", fromProfile: "gerhard", toProfile: "partner", note: "actually look now" });
  const rowCount = (
    sqlite.prepare("SELECT COUNT(*) c FROM shares WHERE property_id = ? AND to_profile = ?").get("prop1", "partner") as {
      c: number;
    }
  ).c;
  assert.equal(rowCount, 1, "re-share upserts the existing row rather than inserting a duplicate");
  assert.equal(unreadShareCount("partner"), 1, "re-share bumps it back to unread");
  assert.equal(
    listSharesForProfile("partner").find((s) => s.id === "prop1")!.share.note,
    "actually look now",
    "note updated by re-share",
  );

  // --- sort: unread first, then newest-first within each bucket ---
  sqlite
    .prepare(
      `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
       VALUES (?, 'domain', 'https://example.com/listing-3', ?, ?, ?)`,
    )
    .run("prop3", now, now, now);
  const sqlNow = sqlite.prepare(`SELECT datetime('now') d`).get() as { d: string };
  const t = (offsetSec: number) => new Date(new Date(sqlNow.d + "Z").getTime() + offsetSec * 1000).toISOString();
  sqlite.exec("DELETE FROM shares WHERE to_profile = 'sorter'");
  const insertShare = sqlite.prepare(
    `INSERT INTO shares (id, property_id, from_profile, to_profile, note, created_at, read_at)
     VALUES (?, ?, 'gerhard', 'sorter', NULL, ?, ?)`,
  );
  // Oldest unread, newest unread, oldest read, newest read — inserted out of
  // the order they should sort in, so an inverted comparator would be caught.
  insertShare.run("s-old-unread", "prop1", t(0), null);
  insertShare.run("s-new-unread", "prop2", t(10), null);
  insertShare.run("s-old-read", "prop3", t(20), t(21));
  const sorted = listSharesForProfile("sorter").map((s) => s.share.id);
  assert.deepEqual(
    sorted,
    ["s-new-unread", "s-old-unread", "s-old-read"],
    "unread bucket first (newest unread first), then read bucket (newest first)",
  );

  // ---------------------------------------------------------------------
  // API boundary — this is where the hard constraint actually lives
  // ---------------------------------------------------------------------

  const postShares = (body: unknown) =>
    sharesPost(
      new Request("http://localhost:3000/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  // literal `null` body -> 400, not a 500 from destructuring null.propertyId
  {
    const res = await sharesPost(
      new Request("http://localhost:3000/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );
    assert.equal(res.status, 400, "literal null JSON body -> 400");
  }

  // self-share rejected
  {
    const res = await postShares({ propertyId: "prop1", fromProfile: "gerhard", toProfile: "gerhard" });
    assert.equal(res.status, 400, "sharing with yourself -> 400");
  }

  // missing propertyId
  {
    const res = await postShares({ fromProfile: "gerhard", toProfile: "partner" });
    assert.equal(res.status, 400, "missing propertyId -> 400");
  }

  // whitespace-only profile
  {
    const res = await postShares({ propertyId: "prop1", fromProfile: "gerhard", toProfile: "   " });
    assert.equal(res.status, 400, "whitespace-only toProfile -> 400");
  }

  // non-existent property
  {
    const res = await postShares({ propertyId: "does-not-exist", fromProfile: "gerhard", toProfile: "partner" });
    assert.equal(res.status, 400, "non-existent property -> 400");
  }

  // non-string toProfile is rejected, not coerced (String({a:1}) === "[object Object]" etc.)
  {
    const res = await postShares({ propertyId: "prop1", fromProfile: "gerhard", toProfile: 42 });
    assert.equal(res.status, 400, "numeric toProfile -> 400, not coerced to \"42\"");
    const rowsWithCoercedProfile = (
      sqlite.prepare("SELECT COUNT(*) c FROM shares WHERE to_profile = '42'").get() as { c: number }
    ).c;
    assert.equal(rowsWithCoercedProfile, 0, "no row was written with a coerced profile string");
  }
  {
    const res = await postShares({ propertyId: "prop1", fromProfile: "gerhard", toProfile: ["johanita"] });
    assert.equal(res.status, 400, "array toProfile -> 400, not coerced to \"johanita\"");
  }

  // GET requires a profile
  {
    const res = await sharesGet(new Request("http://localhost:3000/api/shares"));
    assert.equal(res.status, 400, "GET without ?profile -> 400");
  }

  // /api/shares/read: null body -> 400
  {
    const res = await readPost(
      new Request("http://localhost:3000/api/shares/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );
    assert.equal(res.status, 400, "literal null JSON body on /read -> 400");
  }

  // /api/shares/read: non-array ids -> 400
  {
    const res = await readPost(
      new Request("http://localhost:3000/api/shares/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "partner", ids: "not-an-array" }),
      }),
    );
    assert.equal(res.status, 400, "non-array ids -> 400");
  }

  // /api/shares/read: happy path only marks the given ids
  {
    const before = unreadShareCount("other");
    assert.equal(before, 1, "sanity: other still has one unread share");
    const otherShareId = listSharesForProfile("other")[0].share.id;
    const res = await readPost(
      new Request("http://localhost:3000/api/shares/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "other", ids: [otherShareId] }),
      }),
    );
    assert.equal(res.status, 200, "valid mark-read -> 200");
    assert.equal(unreadShareCount("other"), 0, "the given id was marked read");
  }

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ shares.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ shares.test FAILED:", e);
  process.exit(1);
});
