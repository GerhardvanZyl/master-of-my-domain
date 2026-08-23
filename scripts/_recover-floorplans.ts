/**
 * Job 2 (2026-08-23 straggler round): recover floorplans already stored but
 * never marked, for the 51 live-VIC properties data/harvest/_audit-hero-floorplan.json
 * lists under `noFloorplan`.
 *
 * Real gap being fixed: scripts/_tag-remote.ts applies `notes: "floorplan"`
 * with `ifAbsent: true`, so any image that already carried ANY tag row (even
 * one with roomType='other' from the generic room prompt) silently kept its
 * old notes and the floorplan mark was dropped — setImageTagIfAbsent is an
 * `ON CONFLICT DO NOTHING` insert, not a per-column upsert.
 *
 * classifyRoom()'s generic ROOM_PROMPT collapses floorplans, site plans,
 * locality maps and unreadable detail shots all into "other" (see
 * src/lib/room-classify.ts) and cannot tell them apart, so this uses its own
 * dedicated floorplan yes/no prompt (FLOORPLAN_PROMPT below) instead.
 *
 * Two hard constraints:
 *  - Never overwrite the hero. notes='hero' and notes='floorplan' share the
 *    same column (see src/db/queries/properties.ts pickHero()/isVisibleImage()),
 *    and this job's writes use ifAbsent:false (must overwrite an existing
 *    'other' tag), so the hero image is excluded from candidates entirely
 *    before the model ever sees it. The hero is identified from the exact
 *    notes='hero' field in the live page's flight-JSON (see _live-http.mjs
 *    header for why that's reliable, not a rendered-page guess) — if no
 *    image on a property carries notes='hero', that property is SKIPPED and
 *    reported rather than guessed at via pickHero()'s fallback heuristics.
 *  - roomType is left as whatever the model already classified it (usually
 *    "other") — floorplan is a notes value, not a room type, and "floorplan"
 *    is not in ROOM_TYPES.
 *
 * Usage: npx tsx scripts/_recover-floorplans.ts
 */
import fs from "node:fs";
import path from "node:path";
import { prepareImage } from "@/lib/image-prep";
import { askLocal } from "@/lib/local-llm";
import { DEFAULT_VISION_MODEL } from "@/lib/room-classify";
import { getLiveImages, mapLimit } from "./_live-http.mjs";

const BASE = process.env.LIVE_BASE ?? "http://192.168.68.125:3225";
const H = "data/harvest";
const TMP = process.env.REMOTE_IMG_DIR ?? "./.remote-imgs-floorplan";
const MODEL = process.env.LOCAL_VLM_MODEL || DEFAULT_VISION_MODEL;
// Below this, treat the model's "yes" as too weak to overwrite a live tag on.
const FLOORPLAN_THRESHOLD = 0.6;

export const FLOORPLAN_PROMPT = `You are looking at one photo from an Australian real-estate listing.
Decide whether this specific image IS the property's architectural floorplan
— a top-down schematic diagram of the dwelling showing room layout, walls,
door/window openings, and (usually) room labels or dimensions.

Answer isFloorplan: true ONLY for that kind of diagram.
Answer isFloorplan: false for everything else, including:
- an ordinary photograph of any room, exterior, garden, or streetscape
- a site plan or lot/subdivision plan (property boundary outline, no interior room layout)
- a locality map, or an annotated aerial/drone shot of the neighbourhood
- agency branding, logo cards, or text/marketing panels with no floorplan content

confidence is your own probability that isFloorplan is correct: 1.0 means
certain, 0.5 means you are genuinely unsure. Be honest — a low number is
useful, an inflated one puts a wrong label in the database.`;

const FLOORPLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    isFloorplan: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["isFloorplan", "confidence"],
  additionalProperties: false,
};

interface FloorplanVerdict {
  isFloorplan: boolean;
  confidence: number;
  source: "model" | "rule";
}

async function classifyFloorplan(absPath: string, model: string): Promise<FloorplanVerdict> {
  const prepared = prepareImage(absPath);
  if (prepared.kind === "svg") {
    // Same rationale as room-classify.ts's SVG_VERDICT: every SVG in this
    // library is agency branding, never a floorplan, and ffmpeg can't decode
    // SVG at all.
    return { isFloorplan: false, confidence: 1, source: "rule" };
  }
  const raw = (await askLocal({
    model,
    prompt: FLOORPLAN_PROMPT,
    imageBuffer: prepared.buffer,
    imageMime: prepared.mime,
    schema: FLOORPLAN_SCHEMA,
    schemaName: "floorplan_verdict",
  })) as { isFloorplan?: unknown; confidence?: unknown };
  if (typeof raw.isFloorplan !== "boolean") {
    throw new Error(`Model returned an invalid isFloorplan: ${JSON.stringify(raw.isFloorplan)}`);
  }
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    throw new Error(`Model returned an invalid confidence: ${JSON.stringify(raw.confidence)}`);
  }
  return { isFloorplan: raw.isFloorplan, confidence: raw.confidence, source: "model" };
}

interface LiveImage {
  id: string;
  propertyId: string;
  localPath: string;
  roomType: string | null;
  notes: string | null;
}

async function main() {
  const audit = JSON.parse(fs.readFileSync(`${H}/_audit-hero-floorplan.json`, "utf8")) as {
    noFloorplan: { id: string; address: string; imageCount: number }[];
  };
  const targets = audit.noFloorplan;
  console.log(`candidates: ${targets.length}`);
  fs.mkdirSync(TMP, { recursive: true });

  const tags: Record<string, unknown>[] = [];
  const skippedHeroAmbiguous: { id: string; address: string }[] = [];
  const genuinelyNoFloorplan: { id: string; address: string }[] = [];
  const recovered: { id: string; address: string; imageId: string; confidence: number }[] = [];
  let errored = 0;

  for (const p of targets) {
    const imgs = (await getLiveImages(BASE, p.id)) as LiveImage[];
    const hero = imgs.find((i) => i.notes === "hero");
    if (!hero) {
      console.log(`\n${p.address} (${p.id}) — NO explicit hero found, skipping (cannot safely identify it)`);
      skippedHeroAmbiguous.push({ id: p.id, address: p.address });
      continue;
    }
    const candidates = imgs.filter((i) => i.id !== hero.id);
    console.log(`\n${p.address} (${p.id}) — ${candidates.length} candidates (hero excluded: ${hero.id})`);

    let best: { imageId: string; confidence: number } | null = null;
    for (const im of candidates) {
      const ext = path.extname(im.localPath) || ".webp";
      const file = path.join(TMP, `${im.id}${ext}`);
      try {
        if (!fs.existsSync(file)) {
          const r = await fetch(`${BASE}/api/img/${p.id}/${im.id}${ext}`);
          if (!r.ok) throw new Error(`img ${r.status}`);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        }
        const verdict = await classifyFloorplan(path.resolve(file), MODEL);
        process.stdout.write(
          `${im.id}:${verdict.isFloorplan ? "FP" : "no"}(${verdict.confidence.toFixed(2)}) `,
        );
        if (verdict.isFloorplan && verdict.confidence >= FLOORPLAN_THRESHOLD) {
          if (!best || verdict.confidence > best.confidence) {
            best = { imageId: im.id, confidence: verdict.confidence };
          }
        }
      } catch (e) {
        errored++;
        process.stdout.write(`${im.id}:ERR(${(e as Error).message}) `);
      }
    }

    if (best) {
      recovered.push({ id: p.id, address: p.address, imageId: best.imageId, confidence: best.confidence });
      tags.push({
        propertyId: p.id,
        address: p.address,
        imageId: best.imageId,
        // Left as whatever the model already classified — floorplan is a
        // notes value, not a room type; the pre-existing tag row's roomType
        // (from _tag-remote.ts's pass, usually "other") is preserved by
        // re-reading it here rather than inventing one.
        roomType: imgs.find((i) => i.id === best!.imageId)?.roomType ?? "other",
        confidence: best.confidence,
        notes: "floorplan",
        taggedBy: "local-vlm",
        ifAbsent: false,
      });
    } else {
      genuinelyNoFloorplan.push({ id: p.id, address: p.address });
    }
  }

  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(`${H}/_tags-floorplan-recover.json`, JSON.stringify({ tags }, null, 1));
  const stripped = tags.map(({ imageId, roomType, confidence, notes, taggedBy, ifAbsent }) => ({
    imageId,
    roomType,
    confidence,
    notes,
    taggedBy,
    ifAbsent,
  }));
  fs.writeFileSync(
    `${H}/_batch-tags-floorplan-recover.json`,
    JSON.stringify({ tags: stripped }, null, 1),
  );
  fs.writeFileSync(
    `${H}/_floorplan-recover-report.json`,
    JSON.stringify(
      { candidates: targets.length, recovered, skippedHeroAmbiguous, genuinelyNoFloorplan, errored },
      null,
      1,
    ),
  );

  console.log(
    "\n" +
      JSON.stringify(
        {
          candidates: targets.length,
          recovered: recovered.length,
          skippedHeroAmbiguous: skippedHeroAmbiguous.length,
          genuinelyNoFloorplan: genuinelyNoFloorplan.length,
          errored,
        },
        null,
        1,
      ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
