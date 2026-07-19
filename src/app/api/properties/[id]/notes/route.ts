import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { properties } from "@/db/schema";

// PATCH /api/properties/<id>/notes  { domainNotes: string }
// Save my own notes for a property (empty string clears them).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { domainNotes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const notes = typeof body.domainNotes === "string" ? body.domainNotes.trim() : "";
  const res = db
    .update(properties)
    .set({ domainNotes: notes || null, updatedAt: new Date().toISOString() })
    .where(eq(properties.id, id))
    .run();
  if (res.changes === 0) {
    return NextResponse.json({ error: "no such property" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
