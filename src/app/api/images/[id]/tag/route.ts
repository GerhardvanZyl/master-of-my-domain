import { NextResponse } from "next/server";
import { setImageTag, isRoomType } from "@/db/queries/tags";
import { ROOM_TYPES } from "@/db/schema";

// PATCH /api/images/<id>/tag  { roomType: <RoomType>, notes?: string }
// Correct/overwrite a photo's room tag from the UI. Idempotent (upsert).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { roomType?: string; notes?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const roomType = body.roomType;
  if (!roomType || !isRoomType(roomType)) {
    return NextResponse.json(
      { error: `roomType must be one of: ${ROOM_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  try {
    setImageTag({ imageId: id, roomType, notes: body.notes ?? null, taggedBy: "user" });
    return NextResponse.json({ ok: true, imageId: id, roomType });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
}
