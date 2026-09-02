/**
 * Tag the realestate.com.au photos on the LIVE app.
 *
 * _tag-remote.ts cannot do these. It is driven by a Domain listing-pass harvest
 * (pass-N.json, keyed by Domain listing URL) and by feed.json, which supplies
 * the cover basename it uses to work out which gallery slot is the hero. REA
 * rows have neither: they were captured through the hash bridge, not a Domain
 * pass, and REA has no equivalent feed.
 *
 * The hero needs no work here. pickHero() ranks images through urlIds(), which
 * parses Domain's CDN filename and returns null for REA, so for an REA listing
 * ordinal 0 IS the hero — and rea.ts already puts og:image there at ingest.
 * That leaves room classification, which is what this does.
 *
 * Usage: npx tsx scripts/_tag-remote-rea.ts <out-payload.json>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRoom, DEFAULT_VISION_MODEL } from "@/lib/room-classify";
import { isMachineTagged } from "@/lib/photo";
import { getAllLiveProperties, getLiveImages } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;

interface LiveImage {
  id: string;
  ordinal: number;
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
}

/**
 * Never overwrite a person's correction. An absent tag, or one written by the
 * model or by a deterministic rule, is fair game; anything else was a human
 * deciding, and this pass defers to it.
 */
export function isMachineOrAbsent(taggedBy: string | null): boolean {
  return !taggedBy || isMachineTagged(taggedBy) || taggedBy === "rule";
}

export function shouldClassifyRea(im: Pick<LiveImage, "roomType" | "taggedBy">): boolean {
  if (!im.roomType) return true;
  return isMachineOrAbsent(im.taggedBy);
}

async function main() {
  const props = (await getAllLiveProperties(BASE)) as {
    id: string;
    address: string | null;
    listingUrl: string;
    delisted?: boolean;
  }[];
  const rea = props.filter(
    (p) => !p.delisted && /realestate\.com\.au/.test(p.listingUrl || ""),
  );
  console.log(`live REA properties: ${rea.length}`);

  fs.mkdirSync(TMP, { recursive: true });
  const tags: Record<string, unknown>[] = [];
  let classified = 0,
    skipped = 0,
    errored = 0;

  for (const p of rea) {
    const imgs = (await getLiveImages(BASE, p.id)) as LiveImage[];
    const todo = imgs.filter(shouldClassifyRea);
    console.log(`\n${p.address ?? p.listingUrl} -> ${p.id} | imgs ${imgs.length} (to tag ${todo.length})`);

    for (const im of imgs) {
      if (!shouldClassifyRea(im)) {
        skipped++;
        continue;
      }
      const file = path.join(TMP, `${im.id}.webp`);
      try {
        if (!fs.existsSync(file)) {
          const r = await fetch(`${BASE}/api/img/${p.id}/${im.id}.webp`);
          if (!r.ok) throw new Error(`img ${r.status}`);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        }
        const verdict = await classifyRoom(path.resolve(file), MODEL);
        classified++;
        tags.push({
          // Stripped before the push; the group top-up uses it to pick one
          // representative image per property per room.
          propertyId: p.id,
          ordinal: im.ordinal,
          imageId: im.id,
          roomType: verdict.room,
          confidence: verdict.confidence,
          // No "floorplan" note. Domain puts its plan last so position alone
          // identifies it; REA's sits anywhere in the reel and its alt text
          // ("Media Overview Image 12") does not say, so guessing here would
          // mislabel hallways and detail shots — the app's aspect rule stays
          // the only floorplan signal for REA.
          notes: `local:${MODEL}`,
          taggedBy: verdict.source === "rule" ? "rule" : "local-vlm",
          // Never clobber a hand correction that landed between the read above
          // and this write.
          ifAbsent: !isMachineOrAbsent(im.taggedBy),
        });
        process.stdout.write(`${im.ordinal}:${verdict.room} `);
      } catch (e) {
        errored++;
        process.stdout.write(`${im.ordinal}:ERR(${(e as Error).message}) `);
      }
    }
  }

  const out = process.argv[2] ?? "rea-tags-payload.json";
  fs.writeFileSync(out, JSON.stringify({ tags }, null, 1));
  console.log("\n" + JSON.stringify({ classified, skipped, errored, tags: tags.length, out }, null, 1));
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
