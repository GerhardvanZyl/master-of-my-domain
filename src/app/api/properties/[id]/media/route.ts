import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { listMedia, mediaDirFor, safeName, MEDIA_MIME } from "@/lib/media";

export const runtime = "nodejs";

// POST /api/properties/<id>/media   multipart form, field "files"
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dir = mediaDirFor(id);
  if (!dir) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const name = safeName(file.name || "upload");
    if (!MEDIA_MIME[path.extname(name).toLowerCase()]) continue; // skip unknown types
    // Prefix keeps same-named uploads from clobbering each other.
    const dest = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
  }
  return NextResponse.json({ ok: true, media: listMedia(id) });
}

// DELETE /api/properties/<id>/media?name=<file>
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dir = mediaDirFor(id);
  const name = new URL(req.url).searchParams.get("name");
  if (!dir || !name) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const file = path.join(dir, safeName(name));
  if (file.startsWith(dir + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
  return NextResponse.json({ ok: true, media: listMedia(id) });
}
