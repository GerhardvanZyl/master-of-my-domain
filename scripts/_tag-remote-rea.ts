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
  localPath: string | null;
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
}

/**
 * Where to fetch an image's bytes from.
 *
 * NOT `<id>.webp`. Domain serves one format so every Domain file is .webp and
 * composing the name works; REA serves both `image.jpg` and a `-format=webp`
 * variant, and the capture keeps the widest per photo whichever that is, so an
 * REA property's files are a mix. Hardcoding .webp 404'd on 580 of 835 images.
 * localPath is "images/<pid>/<id>.<ext>" and /api/img resolves relative to
 * IMAGES_DIR, so the leading segment comes off.
 */
export function imgUrlFor(base: string, propertyId: string, im: Pick<LiveImage, "id" | "localPath">): string {
  const rel = im.localPath?.replace(/^images\//, "");
  return `${base}/api/img/${rel ?? `${propertyId}/${im.id}.webp`}`;
}

/**
 * Never overwrite a person's correction. An absent tag, or one written by the
 * model or by a deterministic rule, is fair game; anything else was a human
 * deciding, and this pass defers to it.
 */
export function isMachineOrAbsent(taggedBy: string | null): boolean {
  return !taggedBy || isMachineTagged(taggedBy) || taggedBy === "rule";
}

export function shouldClassifyRea(
  im: Pick<LiveImage, "roomType" | "taggedBy" | "notes">,
  redoMachineTags = false,
): boolean {
  // notes carries meaning this pass cannot reproduce: "hero" is the listing's
  // cover, "floorplan" is what the app shows as the plan. Re-classifying such
  // an image would rewrite its notes to `local:<model>` and silently drop that,
  // costing a property its cover. Room type alone is never worth that.
  if (im.notes === "hero" || im.notes === "floorplan") return false;
  if (!im.roomType) return true;
  // Default is gap-fill: an image that already has a tag is left as it is.
  // Re-doing every machine tag meant a sweep over the live rows queued
  // thousands of already-correct photos through the model to reach 36 that
  // needed it. REDO_MACHINE_TAGS=1 asks for the expensive behaviour explicitly
  // — for a prompt or model change, where re-running the lot is the point.
  return redoMachineTags && isMachineOrAbsent(im.taggedBy);
}

async function main() {
  const props = (await getAllLiveProperties(BASE)) as {
    id: string;
    address: string | null;
    listingUrl: string;
    delisted?: boolean;
  }[];
  // TAG_ALL=1 widens this to every live row, not just the ones whose
  // listing_url is REA. upsertProperty matches an existing property by address,
  // so an REA capture of a listing already held from Domain MERGES into that
  // Domain row — 90 Seabrook Boulevard carries 17 Domain photos and 17 REA
  // ones under a domain.com.au URL. Filtering on the URL leaves those REA
  // photos untagged forever.
  const rea = props.filter(
    (p) =>
      !p.delisted &&
      (process.env.TAG_ALL === "1" || /realestate\.com\.au/.test(p.listingUrl || "")),
  );
  console.log(`live properties to walk: ${rea.length}`);

  fs.mkdirSync(TMP, { recursive: true });
  const REDO = process.env.REDO_MACHINE_TAGS === "1";
  const tags: Record<string, unknown>[] = [];
  let classified = 0,
    skipped = 0,
    errored = 0;

  for (const p of rea) {
    const imgs = (await getLiveImages(BASE, p.id)) as LiveImage[];
    const todo = imgs.filter((im) => shouldClassifyRea(im, REDO));
    console.log(`\n${p.address ?? p.listingUrl} -> ${p.id} | imgs ${imgs.length} (to tag ${todo.length})`);

    for (const im of imgs) {
      if (!shouldClassifyRea(im, REDO)) {
        skipped++;
        continue;
      }
      const url = imgUrlFor(BASE, p.id, im);
      const file = path.join(TMP, path.basename(new URL(url).pathname));
      try {
        if (!fs.existsSync(file)) {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`img ${r.status} ${url.split("/").pop()}`);
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
