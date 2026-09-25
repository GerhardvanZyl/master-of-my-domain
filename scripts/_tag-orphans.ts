/**
 * Tag the images `GET /api/batch` reports as untagged but `_tag-remote.ts`
 * can never reach.
 *
 * _tag-remote.ts discovers image ids by reading the live PROPERTY PAGE, and
 * only VISIBLE images reach the client (isVisibleImage() filters server-side).
 * An image that is both untagged and outside pickFloorplan's aspect window is
 * therefore invisible to that discovery — it can never be tagged by the normal
 * pass, and it stays untagged for ever. 63 such images survived the 2026-09-25
 * round with both taggers reporting clean.
 *
 * The coverage endpoint lists them outright (untaggedImages.images), so this
 * takes the ids from there instead of from a page, and classifies with the
 * same model and helper as every other tagging pass.
 *
 * Usage: npx tsx scripts/_tag-orphans.ts <out-payload.json>
 */
import fs from "node:fs";
import path from "node:path";
import { classifyRoom, DEFAULT_VISION_MODEL } from "@/lib/room-classify";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;

interface Orphan {
  imageId: string;
  propertyId: string;
  address: string | null;
  ordinal: number;
}

const out = process.argv[2] ?? "data/harvest/_tags-orphans.json";

const status = (await fetch(`${BASE}/api/batch`).then((r) => r.json())) as {
  untagged: number;
  untaggedImages?: { images?: Orphan[] };
};
const orphans = status.untaggedImages?.images ?? [];
console.log(`untagged reported: ${status.untagged}; listed: ${orphans.length}`);
if (!orphans.length) process.exit(0);

fs.mkdirSync(TMP, { recursive: true });
const tags: unknown[] = [];
let errored = 0;

for (const o of orphans) {
  let file: string | null = null;
  // The gallery slot can be any of these; /api/img 404s the wrong guess
  // rather than redirecting, so try each (same as _tag-remote.ts).
  for (const ext of ["webp", "jpg", "png", "gif"]) {
    const f = path.join(TMP, `${o.imageId}.${ext}`);
    const r = await fetch(`${BASE}/api/img/${o.propertyId}/${o.imageId}.${ext}`);
    if (!r.ok) continue;
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    file = f;
    break;
  }
  if (!file) {
    console.log(`  img 404 (all extensions) ${o.imageId} — ${o.address ?? o.propertyId}`);
    errored++;
    continue;
  }
  try {
    const verdict = await classifyRoom(path.resolve(file), MODEL);
    tags.push({
      imageId: o.imageId,
      // RoomVerdict calls it `room` (src/lib/room-classify.ts), not roomType.
      roomType: verdict.room,
      confidence: verdict.confidence,
      // source is "rule" for the deterministic SVG -> exclude verdict; keeping
      // that distinct from a model tag matters to isMachineOrAbsent's partition.
      taggedBy: verdict.source === "rule" ? "rule" : "local-vlm",
      // These were never tagged, so there is nothing to clobber; ifAbsent
      // keeps that true even if one is tagged by hand between now and the push.
      ifAbsent: true,
    });
    console.log(`  ${o.imageId} ${verdict.room} (${verdict.source}) — ${o.address ?? o.propertyId}`);
  } catch (e) {
    console.log(`  classify failed ${o.imageId}: ${String(e)}`);
    errored++;
  }
}

fs.writeFileSync(out, JSON.stringify({ tags }, null, 1));
console.log(JSON.stringify({ listed: orphans.length, tagged: tags.length, errored, out }));
