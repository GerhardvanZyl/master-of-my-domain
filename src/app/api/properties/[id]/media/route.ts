import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { listMedia, mediaDirFor, safeName, isSupportedMedia } from "@/lib/media";

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
  await fs.promises.mkdir(dir, { recursive: true });
  const skipped: string[] = [];
  let saved = 0;
  for (const file of files) {
    const name = safeName(file.name || "upload");
    if (!isSupportedMedia(name)) {
      skipped.push(name);
      continue;
    }
    // Prefix keeps same-named uploads from clobbering each other.
    const dest = path.join(dir, `${Date.now()}-${name}`);
    // Async write: a walk-through video is tens of MB, and writeFileSync parks
    // the single Node thread on disk I/O for the whole file (same reason
    // /api/img went async).
    await fs.promises.writeFile(dest, Buffer.from(await file.arrayBuffer()));
    saved++;
  }
  // A 200 here would tell the offline outbox the job is done and delete the
  // queued photo — silently losing it. Nothing stored => say so.
  if (saved === 0) {
    return NextResponse.json(
      { error: `unsupported file type: ${skipped.join(", ")}` },
      { status: 415 },
    );
  }
  return NextResponse.json({ ok: true, media: listMedia(id), skipped });
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
