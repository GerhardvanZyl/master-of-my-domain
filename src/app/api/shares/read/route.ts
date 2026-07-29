import { NextResponse } from "next/server";
import { markSharesRead } from "@/db/queries/shares";

export const runtime = "nodejs";

// POST /api/shares/read  { profile, ids }  -> marks the given share ids read for
// that profile. `ids` is the set of share ids the caller actually displayed
// (from a prior GET /api/shares) — marking "all unread for this profile"
// instead would silently swallow a share that arrives between the list fetch
// and this call.
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

  if (typeof b.profile !== "string") {
    return NextResponse.json({ error: "profile must be a string" }, { status: 400 });
  }
  const profile = b.profile.trim();
  if (!profile) return NextResponse.json({ error: "profile required" }, { status: 400 });

  if (!Array.isArray(b.ids) || b.ids.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "ids must be an array of strings" }, { status: 400 });
  }
  const ids = (b.ids as string[]).map((id) => id.trim()).filter(Boolean);

  markSharesRead(profile, ids);
  return NextResponse.json({ ok: true });
}
