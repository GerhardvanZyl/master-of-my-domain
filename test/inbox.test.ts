/**
 * /inbox mark-read-on-open (see .claude/review/runs/20260920-1449-bugfix/brief.md,
 * ITEM 3). Same offline pattern as shares.test.ts (temp DB, route handlers
 * called directly with a constructed Request, no server boot) — this file
 * does NOT render InboxPage itself: there's no React rendering harness in this
 * repo (no jsdom/testing-library) and the brief asks not to add one or reach
 * for the browser harness in ui.test.ts. What's covered instead is the API
 * contract InboxPage's `markOpened` relies on: that GET /api/shares (the list
 * load) has no side effect on read state, and that POST /api/shares/read with
 * exactly the id(s) the page has fetched — never anything it hasn't — is what
 * moves readAt. The React-level guarantee (that markOpened's closure can only
 * ever be called with an id out of `items`) is a JS-closure property, not
 * something exercisable without actually mounting the component; it is NOT
 * covered here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-inbox-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.IMAGES_DIR = path.join(tmp, "images");

async function main() {
  const { migrate } = await import("../src/db/migrate");
  const { sqlite } = await import("../src/db/client");
  const { upsertShare, unreadShareCount, listSharesForProfile } = await import("../src/db/queries/shares");
  const { GET: sharesGet } = await import("../src/app/api/shares/route");
  const { POST: readPost } = await import("../src/app/api/shares/read/route");
  migrate();

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
       VALUES (?, 'domain', 'https://example.com/inbox-listing-1', ?, ?, ?)`,
    )
    .run("prop-inbox-1", now, now, now);
  sqlite
    .prepare(
      `INSERT INTO properties (id, source_site, listing_url, scraped_at, created_at, updated_at)
       VALUES (?, 'domain', 'https://example.com/inbox-listing-2', ?, ?, ?)`,
    )
    .run("prop-inbox-2", now, now, now);

  upsertShare({ propertyId: "prop-inbox-1", fromProfile: "gerhard", toProfile: "partner", note: null });

  const getInbox = () =>
    sharesGet(new Request("http://localhost:3000/api/shares?profile=partner"));

  // --- a share is NOT marked read merely because the list was fetched/rendered ---
  // This is the regression this whole item exists to fix: the old code called
  // mark-read inside the client's load handler the instant the GET resolved.
  // The route handler itself must have no such side effect, whatever the
  // client goes on to do with the response.
  {
    assert.equal(unreadShareCount("partner"), 1, "sanity: one unread share before the list is ever fetched");
    const res = await getInbox();
    assert.equal(res.status, 200, "GET /api/shares succeeds");
    const body = (await res.json()) as { shares: { share: { id: string; readAt: string | null } }[] };
    assert.equal(body.shares.length, 1, "sanity: the list contains the share");
    assert.equal(body.shares[0].share.readAt, null, "share is still unread in the response the list renders from");
    assert.equal(
      unreadShareCount("partner"),
      1,
      "fetching (and by extension rendering) the list does not mark anything read",
    );
  }

  const shownId = listSharesForProfile("partner")[0].share.id;

  // --- a share that arrives AFTER the list was fetched (never shown) must
  // never be marked read by opening something else. Simulates the race the
  // inbox/page.tsx:39-43 comment names: a share landing between the GET and
  // the user opening a property must not be silently swallowed. ---
  upsertShare({ propertyId: "prop-inbox-2", fromProfile: "gerhard", toProfile: "partner", note: null });
  const neverShownId = listSharesForProfile("partner").find((s) => s.id === "prop-inbox-2")!.share.id;
  assert.equal(unreadShareCount("partner"), 2, "sanity: two unread shares now exist for partner");

  // --- opening a property that WAS shown marks exactly that share read ---
  // (this is what markOpened does: POST with a single-element ids array
  // containing only the id its own closure captured from the already-fetched list)
  {
    const res = await readPost(
      new Request("http://localhost:3000/api/shares/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "partner", ids: [shownId] }),
      }),
    );
    assert.equal(res.status, 200, "mark-read-on-open succeeds");
    assert.notEqual(
      listSharesForProfile("partner").find((s) => s.share.id === shownId)!.share.readAt,
      null,
      "the opened share is now read",
    );
  }

  // --- the never-shown share is untouched by that same open ---
  assert.equal(
    listSharesForProfile("partner").find((s) => s.share.id === neverShownId)!.share.readAt,
    null,
    "a share that was never in the fetched list stays unread when a different share is opened",
  );
  assert.equal(unreadShareCount("partner"), 1, "exactly one share (the opened one) moved from unread to read");

  sqlite.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  console.log("✓ inbox.test: all assertions passed");
}

main().catch((e) => {
  console.error("✗ inbox.test FAILED:", e);
  process.exit(1);
});
