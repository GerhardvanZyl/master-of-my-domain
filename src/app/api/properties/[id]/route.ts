import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";

// Fields the detail rail may edit. Anything else in the body is ignored.
const TRI = ["hasEaves", "pergolaCovered", "hasLawn"] as const; // 1 | 0 | null
const TEXTS = ["pros", "cons"] as const; // newline-separated lists
const SHORTLIST = ["must-see", "maybe", "rejected"];

// PATCH /api/properties/<id>  { shortlistTag?, hasEaves?, pros?, … }
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
  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const res = db.update(properties).set(patch).where(eq(properties.id, id)).run();
  if (res.changes === 0) {
    return NextResponse.json({ error: "no such property" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
