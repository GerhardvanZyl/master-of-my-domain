import { NextResponse } from "next/server";
import { unreadShareCount } from "@/db/queries/shares";

export const runtime = "nodejs";

// GET /api/shares/unread?profile=<profile>  -> { count } — polled by the header badge.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const profile = (url.searchParams.get("profile") ?? "").trim();
  if (!profile) {
    return NextResponse.json({ error: "profile required" }, { status: 400 });
  }
  return NextResponse.json({ count: unreadShareCount(profile) });
}
