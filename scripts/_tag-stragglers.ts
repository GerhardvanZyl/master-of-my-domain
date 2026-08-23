/**
 * Job 1 (2026-08-23 straggler round): tag every untagged image across ALL
 * properties on the LIVE app — not just live VIC (scripts/_tag-remote.ts's
 * pass-1 only ever covered listings present in a Domain search feed, so
 * sold/withdrawn properties were never scanned at all).
 *
 * HTTP-only, same constraints as _tag-remote.ts: no local DB, no local image
 * files. Property + image discovery goes through scripts/_live-http.mjs's
 * flight-JSON reader rather than _tag-remote.ts's rendered-HTML badge regex
 * — see that file's header for why it's strictly more precise (it reads the
 * exact DB roomType/notes columns Next serializes into the page, not an
 * approximation reconstructed from a <span> badge).
 *
 * "Untagged" here means exactly what GET /api/batch and tagStatus() mean by
 * it: image_tags.room_type IS NULL. ifAbsent:true on every push, so a row
 * that already exists for any reason (even one with room_type null — see
 * setImageTagIfAbsent's ON CONFLICT DO NOTHING) is left alone, never
 * clobbered.
 *
 * Usage: npx tsx scripts/_tag-stragglers.ts
 */
import fs from "node:fs";
import path from "node:path";
import { classifyRoom, DEFAULT_VISION_MODEL } from "@/lib/room-classify";
import { getAllLiveProperties, getLiveImages, mapLimit } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs-stragglers";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;

interface LiveImage {
  id: string;
  propertyId: string;
  localPath: string;
  ordinal: number;
  roomType: string | null;
  notes: string | null;
}

async function main() {
  const props = await getAllLiveProperties(BASE);
  console.log(`properties: ${props.length}`);
  fs.mkdirSync(TMP, { recursive: true });

  // Discovery pass: which properties have any untagged (roomType == null)
  // image at all. Politeness: at most 4 property-page fetches in flight.
  const withUntagged: { id: string; address: string; imgs: LiveImage[] }[] = [];
  let scanned = 0;
  await mapLimit(props, 4, async (p: { id: string; address: string }) => {
    const imgs = (await getLiveImages(BASE, p.id)) as LiveImage[];
    const untagged = imgs.filter((i) => i.roomType == null);
    scanned++;
    if (scanned % 50 === 0) console.log(`  scanned ${scanned}/${props.length}`);
    if (untagged.length) withUntagged.push({ id: p.id, address: p.address, imgs: untagged });
  });

  console.log(
    `properties with an untagged image: ${withUntagged.length}, ` +
      `total untagged images found over HTTP: ${withUntagged.reduce((n, p) => n + p.imgs.length, 0)}`,
  );

  const tags: Record<string, unknown>[] = [];
  let classified = 0,
    errored = 0;

  for (const p of withUntagged) {
    console.log(`\n${p.address} (${p.id}) — ${p.imgs.length} untagged`);
    for (const im of p.imgs) {
      const ext = path.extname(im.localPath) || ".webp";
      const file = path.join(TMP, `${im.id}${ext}`);
      try {
        if (!fs.existsSync(file)) {
          const r = await fetch(`${BASE}/api/img/${p.id}/${im.id}${ext}`);
          if (!r.ok) throw new Error(`img ${r.status}`);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        }
        const verdict = await classifyRoom(path.resolve(file), MODEL);
        classified++;
        tags.push({
          // Extra context, stripped before push — see _batch-tags-straggler.json.
          propertyId: p.id,
          address: p.address,
          imageId: im.id,
          roomType: verdict.room,
          confidence: verdict.confidence,
          notes: `local:${MODEL}`,
          taggedBy: verdict.source === "rule" ? "rule" : "local-vlm",
          ifAbsent: true,
        });
        process.stdout.write(`${im.id}:${verdict.room} `);
      } catch (e) {
        errored++;
        process.stdout.write(`${im.id}:ERR(${(e as Error).message}) `);
      }
    }
  }

  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(`${H}/_tags-straggler.json`, JSON.stringify({ tags }, null, 1));
  const stripped = tags.map(({ imageId, roomType, confidence, notes, taggedBy, ifAbsent }) => ({
    imageId,
    roomType,
    confidence,
    notes,
    taggedBy,
    ifAbsent,
  }));
  fs.writeFileSync(`${H}/_batch-tags-straggler.json`, JSON.stringify({ tags: stripped }, null, 1));

  console.log(
    "\n" + JSON.stringify({ propertiesScanned: props.length, classified, errored, tags: tags.length }, null, 1),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
