import { NextResponse } from "next/server";
import { listProperties, deleteProperty } from "@/db/queries/properties";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ properties: listProperties() });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  deleteProperty(id);
  return NextResponse.json({ ok: true });
}
