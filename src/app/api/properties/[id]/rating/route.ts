import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { propertyRatings } from "@/db/schema";

// Allowed values per field; null always clears.
const VOCAB: Record<string, string[]> = {
  vibe: ["like", "meh", "dislike", "hate"],
  look: ["good", "ugly"],
  kitchen: ["small", "tiny"],
};

// PATCH /api/properties/<id>/rating  { profile, vibe?, look?, kitchen?, score? }
// Upserts the (property, profile) row — only the keys present are touched.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const profile = String(body.profile ?? "");
  if (!profile) return NextResponse.json({ error: "profile required" }, { status: 400 });

  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [k, allowed] of Object.entries(VOCAB)) {
    if (k in body) {
      const v = body[k];
      if (v !== null && !allowed.includes(String(v))) {
        return NextResponse.json({ error: `bad ${k}` }, { status: 400 });
      }
      patch[k] = v === null ? null : String(v);
    }
  }
  if ("score" in body) {
    const s = body.score;
    const n = s === null ? null : Number(s);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 10)) {
      return NextResponse.json({ error: "score must be 0–10" }, { status: 400 });
    }
    patch.score = n;
  }

  try {
    db.insert(propertyRatings)
      .values({ propertyId: id, profile, ...patch } as typeof propertyRatings.$inferInsert)
      .onConflictDoUpdate({
        target: [propertyRatings.propertyId, propertyRatings.profile],
        set: patch,
      })
      .run();
  } catch {
    // The only realistic failure is the FK — an id that isn't a property.
    return NextResponse.json({ error: "no such property" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id, profile });
}
