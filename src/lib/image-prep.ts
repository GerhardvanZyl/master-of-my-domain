import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Detects an image's real format from its bytes and converts it into
 * something the local vision model can actually decode. LM Studio's vision
 * pipeline (measured against 7,822 real listing photos) rejects webp
 * outright and chokes on any file whose extension lies about its real
 * content (377 SVGs saved as `.jpg`). Deriving MIME type from the file
 * extension — the old approach in local-llm.ts — made 97% of the library
 * unclassifiable. This module fixes that by sniffing magic bytes and always
 * shipping the model a real JPEG.
 */

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "svg" | "unknown";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Format from magic bytes only — never from the filename/extension. */
export function sniffFormat(buf: Buffer): ImageFormat {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }
  if (buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b)) {
    return "png";
  }
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") {
    return "gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 256)).trim();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) {
    return "svg";
  }
  return "unknown";
}

export interface PrepareImageOptions {
  /** Long edge cap in pixels, aspect preserved. Defaults to 1024. */
  maxEdge?: number;
}

export type PreparedImage =
  | { kind: "image"; buffer: Buffer; mime: "image/jpeg" }
  | { kind: "svg" };

/**
 * Message classifyFailure() in tagging-run.ts keys off of. Kept distinct from
 * both "not reachable" (model server down) and "Could not read image at"
 * (per-photo skip) — a missing ffmpeg binary is a run-level configuration
 * problem, not something a single retried photo will fix.
 */
export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg is required to convert images for the local vision model but was " +
  "not found on PATH — install ffmpeg and make sure `ffmpeg` runs from a shell.";

/**
 * Reads `absPath`, identifies its real format, and returns bytes the local
 * model can decode.
 *
 * - SVG (all 377 are agent logos/branding, never a room) is returned as
 *   `{ kind: "svg" }` without touching ffmpeg at all — ffmpeg has no SVG
 *   decoder (confirmed: `no decoder found for: svg`), so even trying would
 *   just trade one failure mode for another. The caller (room-classify.ts)
 *   is responsible for turning this into the deterministic `other` tag.
 * - Everything else (jpeg/png/gif/webp/unknown) is converted uniformly
 *   through ffmpeg to JPEG, long edge capped at `opts.maxEdge` (default
 *   1024px), never upscaled. Converting the already-working formats too is
 *   deliberate — a uniform path beats a special case for 3% of the library.
 *
 * Piped through stdout — this never writes a temp file, and never touches
 * anything under data/images (which is source-of-truth data).
 */
export function prepareImage(
  absPath: string,
  opts: PrepareImageOptions = {},
): PreparedImage {
  const maxEdge = opts.maxEdge ?? 1024;

  let raw: Buffer;
  try {
    raw = fs.readFileSync(absPath);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not read image at ${absPath}: ${why}`);
  }

  if (sniffFormat(raw) === "svg") {
    return { kind: "svg" };
  }

  const vf =
    `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':` +
    `force_original_aspect_ratio=decrease:force_divisible_by=2`;

  let out: Buffer;
  try {
    out = execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        absPath,
        "-vf",
        vf,
        "-q:v",
        "4",
        "-f",
        "image2",
        "-c:v",
        "mjpeg",
        "pipe:1",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") {
      throw new Error(FFMPEG_MISSING_MESSAGE);
    }
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not read image at ${absPath}: ${why}`);
  }

  return { kind: "image", buffer: out, mime: "image/jpeg" };
}
