/**
 * Tag photos on the LIVE app over HTTP only — no local DB, no local image files.
 *
 * `tag:auto` reads data/app.db and data/images; this round the local DB is
 * off-limits (all writes go to http://192.168.68.125:3225 via POST /api/batch),
 * so instead: discover image ids from the live app's rendered property pages,
 * pull the bytes from /api/img, classify with the same local vision model, and
 * write the tags back through /api/batch.
 *
 * Also sets each listing's hero. Domain's own cover is the search feed's
 * images[0] basename, and we know which slot that basename occupies in the
 * gallery we uploaded, so the hero is simply the image at that ordinal.
 *
 * Usage: npx tsx scripts/_tag-remote.ts <out-payload.json>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRoom, DEFAULT_VISION_MODEL } from "@/lib/room-classify";
import { isMachineTagged } from "@/lib/photo";
import { getLiveImages } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;

const read = (f: string) => JSON.parse(fs.readFileSync(`${H}/${f}`, "utf8"));
const get = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.text();
};
const basename = (u: string) => u.split("/").pop()!.split("?")[0];

interface LiveImage {
  id: string;
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
}

export interface DetectedImage {
  id: string;
  tagged: boolean;
  /** The image's existing tag row, if any — carried through (rather than
   * discarded, as the pre-round-2 version did) so the floorplan decision
   * below can tell a machine-written tag from a hand correction instead of
   * only knowing whether one exists at all. */
  roomType: string | null;
  notes: string | null;
  taggedBy: string | null;
}

/**
 * Which images on a live property page already carry a real tag.
 *
 * Sourced from getLiveImages() — the exact DB `room_type` column, read via
 * the page's flight stream (see _live-http.mjs's header for why that's
 * reliable) — rather than reconstructed from a rendered room badge. The
 * badge regex this replaced (`/uppercase[^>]*>([a-z]+)<\/span>/` applied to
 * the 400 chars after each image id) never fired against the live app's
 * markup: the FIRST occurrence of an image id in the document is always
 * inside a next/image imagesrcset preload with no badge text nearby, so the
 * dedup-by-first-occurrence logic never reached the real badge later in the
 * page. Measured live: 114 of 114 images across 5 properties came back
 * "untagged" though every one of them was in fact tagged.
 */
export async function detectTaggedImages(base: string, propertyId: string): Promise<DetectedImage[]> {
  const liveImages = (await getLiveImages(base, propertyId)) as LiveImage[];
  return liveImages.map((r) => ({
    id: r.id,
    tagged: r.roomType != null,
    roomType: r.roomType,
    notes: r.notes,
    taggedBy: r.taggedBy,
  }));
}

/**
 * Whether image `i` needs to be run through the model at all. The hero
 * always does (its verdict decides nothing but still gets recorded); an
 * untagged image always does. The LAST image is the only slot
 * notes:"floorplan" can ever apply to (see the ternary in main() below), so
 * an already-tagged, non-hero last image is exempted from the "already
 * tagged, skip" rule TOO — but only when the floorplan mark could actually
 * land: `ifAbsentFor` (below) is the single source of truth for whether that
 * write can clobber the existing row, so the exemption asks it directly
 * rather than re-deriving the same machine/hand partition (tech-007,
 * 20260823-1800-fix-tagging-round-defects round 3) — a hand-owned last image
 * cannot be changed by any verdict the model returns, so the download plus
 * inference is skipped for it same as any other already-tagged image.
 *
 * (tech-004, round 2: fixing detectTaggedImages above made the "already
 * tagged, skip" rule fire for the first time, and without SOME isLast
 * exemption a last-position photo that already carries ANY room type — 19 of
 * 25 sampled live properties, per that round's measurement — could never be
 * classified again to check whether it's actually a floorplan.)
 */
export function shouldClassify(
  tagged: boolean,
  isHero: boolean,
  isLast: boolean,
  existingTaggedBy: string | null,
  existingNotes: string | null,
): boolean {
  if (isHero || !tagged) return true;
  if (!isLast) return false;
  return !ifAbsentFor(false, "floorplan", existingTaggedBy, existingNotes);
}

/** `tagged_by` values, beyond src/lib/photo.ts's isMachineTagged set, that are
 * also not a hand correction: "rule" is _tag-remote.ts's/room-classify.ts's own
 * deterministic (non-model) verdict, e.g. SVG -> exclude — automated, not a
 * human's judgement call, so it may be overwritten the same as a model tag. */
function isMachineOrAbsent(existingTaggedBy: string | null): boolean {
  return !existingTaggedBy || isMachineTagged(existingTaggedBy) || existingTaggedBy === "rule";
}

/**
 * Whether this tag row should be pushed as `ifAbsent` (never clobber
 * whatever is already there) or as an unconditional overwrite.
 *
 * Hero always overwrites: an image already carrying an unrelated tag row
 * would otherwise keep it forever, since setImageTagIfAbsent is
 * ON CONFLICT DO NOTHING, not a per-column upsert.
 *
 * Floorplan overwrites conditionally: safe when the existing row is absent
 * or machine-written (nothing a human curated is at risk), but not when a
 * human already owns that image's tag — round 1's tech-001 was exactly this
 * case going undetected because the (then-broken) tagged-detector reported
 * every image as untagged, so `ifAbsent:false` silently clobbered hand
 * corrections. Also never overwrites when `existingNotes === "hero"`
 * (tech-006, round 3): `setImageTag` replaces `notes` wholesale and `notes`
 * is the only column the floorplan mark writes, so a last visible image
 * already carrying the hero marker would otherwise have it silently
 * destroyed regardless of who wrote it — including by this very script's own
 * prior hero write, which is `taggedBy: "local-vlm"` and so would otherwise
 * pass `isMachineOrAbsent`. `existingNotes` is checked in addition to, not
 * instead of, the hand-tagged check above.
 *
 * Every other tag (plain room classification) stays `ifAbsent: true`
 * unconditionally, so a hand correction can never be silently clobbered.
 */
export function ifAbsentFor(
  isHero: boolean,
  notes: string | null,
  existingTaggedBy: string | null,
  existingNotes: string | null,
): boolean {
  if (isHero) return false;
  if (notes === "floorplan") return existingNotes === "hero" || !isMachineOrAbsent(existingTaggedBy);
  return true;
}

/**
 * Floorplan is a `notes` value, not a room type (it's not in ROOM_TYPES).
 * When the floorplan mark lands on an image that already carries a real
 * classification, keep that classification rather than the fresh verdict —
 * `classifyRoom`'s generic prompt collapses floorplans, site plans and
 * unreadable detail shots all into "other", so a fresh "other" is strictly
 * less informative than whatever the image was already tagged. Same
 * precedent as scripts/_recover-floorplans.ts, which re-reads the existing
 * roomType rather than inventing one for exactly this reason.
 */
export function roomTypeFor<T>(notes: string, verdictRoom: T, existingRoomType: string | null): T {
  return notes === "floorplan" && existingRoomType ? (existingRoomType as unknown as T) : verdictRoom;
}

async function main() {
  // PASS_JSON: which harvest to tag. A resumed round produces pass-2, pass-3…
  // and re-running the whole of pass-1 would re-classify photos that are
  // already tagged (the model pass is the expensive part).
  const pass1: Record<string, { imgs?: string[] }> = read(process.env.PASS_JSON ?? "pass-1.json");
  const feed: { rows: unknown[][] } = read("feed.json");
  const items: { listingUrl: string; address?: string }[] = read("feed-items.json");

  // listingUrl -> Domain cover basename (feed images[0] IS the og:image cover)
  const coverByUrl = new Map<string, string>();
  const addrByUrl = new Map<string, string>();
  for (const r of feed.rows) {
    const url = "https://www.domain.com.au" + String(r[0]);
    coverByUrl.set(url, String(r[15] ?? ""));
  }
  for (const it of items) if (it.address) addrByUrl.set(it.listingUrl, it.address);

  // address -> propertyId, scraped from the live home grid
  const home = await get(`${BASE}/`);
  const byAddr = new Map<string, string>();
  // Normalised form, so a listing absent from the current feed (no address in
  // feed-items) can still be matched from its URL slug.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byNorm = new Map<string, string>();
  for (const m of home.matchAll(/href="\/property\/([0-9a-f-]{36})">([^<]{5,120})</g)) {
    byAddr.set(m[2].trim(), m[1]);
    byNorm.set(norm(m[2]), m[1]);
  }
  console.log(`home grid: ${byAddr.size} properties`);
  const slugAddr = (url: string) =>
    norm(url.split("/").pop()!.replace(/-\d{6,}$/, "").replace(/-/g, " "));

  fs.mkdirSync(TMP, { recursive: true });
  const tags: Record<string, unknown>[] = [];
  let classified = 0, skipped = 0, errored = 0;

  for (const [key, v] of Object.entries(pass1)) {
    if (!v.imgs?.length) continue;
    // The pass stores RELATIVE keys ("/5-moncrieff-…"); coverByUrl/addrByUrl are
    // keyed absolute. Without this every cover lookup misses and every listing
    // silently gets "hero slot -1" — same normalisation _pass-apply.mjs does.
    const listingUrl = key.startsWith("http") ? key : "https://www.domain.com.au" + key;
    const addr = addrByUrl.get(listingUrl) ?? "";
    const pid = byAddr.get(addr) ?? byNorm.get(slugAddr(listingUrl));
    if (!pid) {
      console.log(`NO PROPERTY for "${addr}" (${listingUrl})`);
      errored++;
      continue;
    }

    // Ordinal order (getPropertyImages() ORDER BY images.ordinal) = document
    // order — same slot indexing v.imgs (the pass's harvest order) relies on.
    const imgs = await detectTaggedImages(BASE, pid);

    // Which slot is Domain's cover? Full basename first, then the
    // <listingId>_<photoIndex>_ prefix (relisted listings carry another id).
    const cover = coverByUrl.get(listingUrl) ?? "";
    let heroIdx = v.imgs.findIndex((u) => basename(u) === cover);
    if (heroIdx < 0 && cover) {
      const pre = cover.split("_").slice(0, 2).join("_") + "_";
      heroIdx = v.imgs.findIndex((u) => basename(u).startsWith(pre));
    }

    console.log(
      `\n${addr} -> ${pid} | imgs ${imgs.length} (untagged ${imgs.filter((i) => !i.tagged).length}) | hero slot ${heroIdx}`,
    );

    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      const isHero = i === heroIdx;
      const isLast = i === imgs.length - 1;
      if (!shouldClassify(im.tagged, isHero, isLast, im.taggedBy, im.notes)) {
        skipped++;
        continue;
      }
      const file = path.join(TMP, `${im.id}.webp`);
      try {
        if (!fs.existsSync(file)) {
          const r = await fetch(`${BASE}/api/img/${pid}/${im.id}.webp`);
          if (!r.ok) throw new Error(`img ${r.status}`);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        }
        const verdict = await classifyRoom(path.resolve(file), MODEL);
        classified++;
        // Domain puts the floorplan last; notes='floorplan' beats the app's
        // aspect-ratio heuristic, which misses plans rendered at 4:3 and 3:2.
        const notes = isHero
          ? "hero"
          : verdict.room === "other" && isLast
            ? "floorplan"
            : `local:${MODEL}`;
        tags.push({
          // Not part of TagInput — stripped before the payload is pushed. It is
          // here so the group top-up can pick one representative image per
          // property per room without a second pass over the live pages.
          propertyId: pid,
          ordinal: i,
          imageId: im.id,
          roomType: roomTypeFor(notes, verdict.room, im.roomType),
          confidence: verdict.confidence,
          notes,
          taggedBy: verdict.source === "rule" ? "rule" : "local-vlm",
          // See ifAbsentFor above for the invariant this encodes.
          ifAbsent: ifAbsentFor(isHero, notes, im.taggedBy, im.notes),
        });
        process.stdout.write(`${i}${isHero ? "*" : ""}:${verdict.room} `);
      } catch (e) {
        errored++;
        process.stdout.write(`${i}:ERR(${(e as Error).message}) `);
      }
    }
  }

  const out = process.argv[2] ?? "tags-payload.json";
  fs.writeFileSync(out, JSON.stringify({ tags }, null, 1));
  console.log(
    "\n" + JSON.stringify({ classified, skipped, errored, tags: tags.length, out }, null, 1),
  );
}

// Only run when this file is the entrypoint — lets tests import
// detectTaggedImages / other exports without triggering a live run.
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
