import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { propertyRatings } from "@/db/schema";

// PATCH /api/properties/<id>/rating
//   { profile: "gerhard"|"johanita", vibe?, look?, kitchen? }
// Partial upsert of one profile's rating for a property — only the fields present
// in the body change; "" clears a field. Both profiles' rows feed the vibe score.
const PROFILES = ["gerhard", "johanita"];
const VIBES = ["like", "meh", "dislike", "hate"];
const LOOKS = ["good", "ugly"];
const KITCHENS = ["small", "tiny"];

function clean(v: unknown, allowed: string[]): string | null | undefined {
  if (v === undefined) return undefined; // not provided → leave as-is
  if (v === "" || v === null) return null; // clear
  return typeof v === "string" && allowed.includes(v) ? v : undefined;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { profile?: string; vibe?: unknown; look?: unknown; kitchen?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.profile || !PROFILES.includes(body.profile)) {
    return NextResponse.json({ error: "unknown profile" }, { status: 400 });
  }
  const vibe = clean(body.vibe, VIBES);
  const look = clean(body.look, LOOKS);
  const kitchen = clean(body.kitchen, KITCHENS);
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(propertyRatings)
    .where(and(eq(propertyRatings.propertyId, id), eq(propertyRatings.profile, body.profile)))
    .get();

  const row = {
    vibe: vibe === undefined ? (existing?.vibe ?? null) : vibe,
    look: look === undefined ? (existing?.look ?? null) : look,
    kitchen: kitchen === undefined ? (existing?.kitchen ?? null) : kitchen,
    updatedAt: now,
  };

  if (existing) {
    db.update(propertyRatings)
      .set(row)
      .where(and(eq(propertyRatings.propertyId, id), eq(propertyRatings.profile, body.profile)))
      .run();
  } else {
    db.insert(propertyRatings)
      .values({ propertyId: id, profile: body.profile, ...row })
      .run();
  }
  return NextResponse.json({ ok: true, id, profile: body.profile, ...row });
}
