import { NextResponse } from "next/server";
import { getSetting, putSetting } from "@/db/queries/settings";
import { parseVibeConfig } from "@/lib/vibes";

export const runtime = "nodejs";

const KEY = "vibeConfig";

// GET /api/config -> { vibeConfig } — always a complete, finite-number config
// (defaults when the row is absent or corrupt).
export async function GET() {
  const vibeConfig = parseVibeConfig(getSetting(KEY));
  return NextResponse.json({ vibeConfig });
}

// PUT /api/config  { ...VibeConfig-shaped body }
// parseVibeConfig gates the body BEFORE it's stored — that's the trust
// boundary, never store raw body JSON (see src/lib/vibes.ts).
export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const vibeConfig = parseVibeConfig(body);
  putSetting(KEY, vibeConfig);
  return NextResponse.json({ ok: true, vibeConfig });
}
