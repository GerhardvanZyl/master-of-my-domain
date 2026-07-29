import { NextResponse } from "next/server";
import { propertyExists } from "@/db/queries/properties";
import { listSharesForProfile, upsertShare } from "@/db/queries/shares";

export const runtime = "nodejs";

const NOTE_MAX = 500;

// GET /api/shares?profile=<profile>  -> shares (with property data) sent TO that profile
export async function GET(req: Request) {
  const url = new URL(req.url);
  const profile = (url.searchParams.get("profile") ?? "").trim();
  if (!profile) {
    return NextResponse.json({ error: "profile required" }, { status: 400 });
  }
  return NextResponse.json({ shares: listSharesForProfile(profile) });
}

// POST /api/shares  { propertyId, fromProfile, toProfile, note? }
// Upserts on (propertyId, toProfile) — re-sharing bumps it back to unread.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  for (const key of ["propertyId", "fromProfile", "toProfile"] as const) {
    if (typeof b[key] !== "string") {
      return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
    }
  }
  if (b.note != null && typeof b.note !== "string") {
    return NextResponse.json({ error: "note must be a string" }, { status: 400 });
  }

  const propertyId = (b.propertyId as string).trim();
  const fromProfile = (b.fromProfile as string).trim();
  const toProfile = (b.toProfile as string).trim();
  const note = b.note == null ? null : (b.note as string).trim().slice(0, NOTE_MAX) || null;

  if (!propertyId) return NextResponse.json({ error: "propertyId required" }, { status: 400 });
  if (!fromProfile) return NextResponse.json({ error: "fromProfile required" }, { status: 400 });
  if (!toProfile) return NextResponse.json({ error: "toProfile required" }, { status: 400 });
  if (fromProfile === toProfile) {
    return NextResponse.json({ error: "cannot share with yourself" }, { status: 400 });
  }
  if (!propertyExists(propertyId)) {
    return NextResponse.json({ error: "no such property" }, { status: 400 });
  }

  const share = upsertShare({ propertyId, fromProfile, toProfile, note });
  return NextResponse.json({ ok: true, share });
}
