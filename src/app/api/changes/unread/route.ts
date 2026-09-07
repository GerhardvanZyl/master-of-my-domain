import { NextResponse } from "next/server";
import { unreadWatchlistChangeCount } from "@/db/queries/changes";
import { getSetting, putSetting } from "@/db/queries/settings";

export const runtime = "nodejs";

// Shared, not per profile — the user's explicit choice (see the brief): one
// watchlist, one "have I seen the latest changes" watermark.
const WATERMARK_KEY = "watchlistSeenAt";

/**
 * GET  /api/changes/unread -> { count }: property_changes rows for a
 * watchlisted property, newer than the last-seen watermark. An absent
 * watermark (nobody has opened the bell yet) means everything is unseen (see
 * unreadWatchlistChangeCount in db/queries/changes.ts).
 */
export async function GET() {
  const seenAt = getSetting(WATERMARK_KEY);
  const since = typeof seenAt === "string" ? seenAt : null;
  return NextResponse.json({ count: unreadWatchlistChangeCount(since) });
}

/** POST /api/changes/unread -> stamps the watermark to now. */
export async function POST() {
  putSetting(WATERMARK_KEY, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
