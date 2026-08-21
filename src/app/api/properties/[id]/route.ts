import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";

// Fields the detail rail may edit. Anything else in the body is ignored.
const TRI = ["hasEaves", "pergolaCovered", "hasLawn"] as const; // 1 | 0 | null
const TEXTS = ["pros", "cons"] as const; // newline-separated lists
const SHORTLIST = ["maybe", "rejected"]; // "must-see" became viewed = "to-view"
const VIEWED = ["viewed", "to-view"]; // + null = neither. The only inspection state.

// PATCH /api/properties/<id>  { viewed?, shortlistTag?, hasEaves?, pros?, … }
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

  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if ("shortlistTag" in body) {
    const t = body.shortlistTag;
    if (t !== null && !SHORTLIST.includes(String(t))) {
      return NextResponse.json({ error: "bad shortlistTag" }, { status: 400 });
    }
    patch.shortlistTag = t === null ? null : String(t);
  }
  for (const k of TRI) {
    if (k in body) {
      const v = body[k];
      if (v !== null && v !== 0 && v !== 1) {
        return NextResponse.json({ error: `bad ${k}` }, { status: 400 });
      }
      patch[k] = v;
    }
  }
  for (const k of TEXTS) {
    if (k in body) patch[k] = String(body[k] ?? "").trim() || null;
  }
  // The one inspection state. Writing it also owns viewed_at, so the date and
  // the enum can't disagree: entering "viewed" stamps today unless a date is
  // already there (COALESCE, so a hand-corrected date survives a re-click),
  // and anything else clears it.
  if ("viewed" in body) {
    const v = body.viewed;
    if (v !== null && !VIEWED.includes(String(v))) {
      return NextResponse.json({ error: "bad viewed" }, { status: 400 });
    }
    patch.viewed = v === null ? null : String(v);
    patch.viewedAt =
      v === "viewed" ? sql`COALESCE(viewed_at, ${new Date().toISOString()})` : null;
  }
  // Correcting the date by hand. After the block above, so a body carrying
  // both wins on the explicit date.
  if ("viewedAt" in body) {
    const v = body.viewedAt;
    if (v !== null && Number.isNaN(Date.parse(String(v)))) {
      return NextResponse.json({ error: "bad viewedAt" }, { status: 400 });
    }
    patch.viewedAt = v === null ? null : String(v);
  }
  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const res = db.update(properties).set(patch).where(eq(properties.id, id)).run();
  if (res.changes === 0) {
    return NextResponse.json({ error: "no such property" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
